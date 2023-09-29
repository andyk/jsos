import { jest } from "@jest/globals";
import _ from "lodash";
import jsos, {
    JsosSession,
    ValStore,
    InMemoryJsonStore,
    InMemoryVarStore,
    VarStoreSubCallback,
    NewVal,
    NewImmutableVar,
    NewVar,
    GetVar,
    DeleteVar,
} from "../src/jsos";
import {
    OrderedMap,
    Map as ImmutableMap,
    Set as ImmutableSet,
} from "immutable";
//import tmp from 'tmp';

//tmp.setGracefulCleanup();

test("Basic ObjectStore and ValStore operations.", async () => {
    const orig = [
        [2, 22],
        [1, 11],
        ["a", "aa"],
    ];
    const js = new InMemoryJsonStore();
    const key = await js.putJson(orig);
    const gotJson = await js.getJson(key);
    expect(orig).toEqual(gotJson);

    const nullKey = await js.putJson(null);
    const nullJson = await js.getJson(nullKey);
    expect(nullJson).toBe(null);

    const vs = new ValStore(js);
    const encoded = vs.encode(orig);
    const normalized = vs.normalize(encoded);
    expect(normalized.length).toBe(10);

    const putVal = await vs.putVal(orig);
    const gotVal = await vs.getVal(putVal[0]);
    expect(orig).toEqual(gotVal);

});

test("ValStore with immutable types", async () => {
    const om = [
        new Date(),
        OrderedMap([
            ["a", { inner: ImmutableSet([1, { innerinner: "inin" }]) }],
            ["b", ImmutableMap([["c", "CC"]])],
        ] as any),
    ];
    // TODO support undefined too
    //const om = OrderedMap(([[ "a", {inner: ImmutableSet([1, {innerinner: "inin"}])}], ["b", "bb"], undefined]) as any);
    const os = new InMemoryJsonStore();
    const vs = new ValStore(os);
    const [putSha1, _] = await vs.putVal(om);
    const gotVal = await vs.getVal(putSha1);
    expect(om).toEqual(gotVal);
});

test("encodeNormalized and decodeNormalized are inverses.", async () => {
    const js = new InMemoryJsonStore();
    const vs = new ValStore(js);
    const encodedNorm = await vs.encodeNormalized(["key1", "key2"]);
    expect(encodedNorm[1].manifest[0]).toBe("key1");
});

test("VarStore basics", async () => {
    const varStore = new InMemoryVarStore();
    expect(await varStore.newVar("name", "namespace", "exampleSha1")).toBe(
        true
    );
    expect(await varStore.newVar("name", "namespace", "exampleSha1")).toBe(
        false
    );
    expect(await varStore.getVar("name", "namespace")).toBe("exampleSha1");
    expect(
        await varStore.updateVar(
            "name",
            "namespace",
            "exampleSha1",
            "newSha1"
        )
    ).toBe(true);
    expect(await varStore.getVar("name", "namespace")).toBe("newSha1");
    expect(
        await varStore.updateVar(
            "name",
            "namespace",
            "wrongCurrentSha1",
            "newSha1"
        )
    ).toBe(false);
    expect(await varStore.getVar("name", "namespace")).toBe("newSha1");
    const callBack: VarStoreSubCallback = jest.fn(
        (n, ns, oldSha1, newSha1) => {
            expect(n).toBe("name");
            expect(ns).toBe("namespace");
            expect(oldSha1).toBe("newSha1");
            expect(newSha1).toBe("newerSha1");
        }
    );
    const subscrID = varStore.subscribeToUpdates("name", "namespace", callBack);
    expect(callBack).toBeCalledTimes(0);
    expect(
        await varStore.updateVar(
            "name",
            "namespace",
            "newSha1",
            "newerSha1"
        )
    ).toBe(true);
    expect(callBack).toBeCalledTimes(1);
    expect(varStore.unsubscribeFromUpdates(subscrID)).toBe(true);
    expect(
        await varStore.updateVar(
            "name",
            "namespace",
            "newerSha1",
            "evenNewerSha1"
        )
    ).toBe(true);
    expect(callBack).toBeCalledTimes(1);
});

test("Val basics", async () => {
    const v0 = await NewVal({ object: null });
    expect(v0).toBeDefined();
    expect(v0.__jsosValObject).toBe(null);
    const init = [1, 2, 3];
    const v1 = await NewVal({ object: init });
    expect(v1.__jsosValObject).toEqual(init);
    expect(v1[0]).toBe(1);
    expect(v1[2]).toBe(3);
    expect(v1.length).toBe(3);
    expect(v1[3]).toBe(undefined);
    const updated = await v1.__jsosUpdate((oldVal: Array<number>) => [
        ...oldVal,
        4,
    ]);
    expect(updated.__jsosValObject).toEqual([1, 2, 3, 4]);
    expect(v1.__jsosSha1).not.toBe(updated.__jsosSha1);

    const strVal: any = await NewVal({ object: "a string" });
    const newStr = await strVal.__jsosUpdate(
        (oldVal: string) => oldVal + " with more"
    );
    expect(newStr.__jsosValObject).toBe("a string with more");

    const boolVal: any = await NewVal({ object: true });
    const newBool = await boolVal.__jsosUpdate(
        (oldVal: boolean) => oldVal && false
    );
    expect(newBool.__jsosValObject).toBe(false);
}, 1000000);

test("Val created from an object that has a simple function", async () => {
    const val = await NewVal({
        object: {
            a: 1,
            b: 2,
            c: function() {
                return this.a + this.b;
            },
        },
    });
    expect(val.a).toBe(1);
    expect(val.b).toBe(2);
    expect(val.c()).toBe(3);
    const updated = await val.__jsosUpdate((oldVal: any) => {
        return { ...oldVal, a: 4 };
    });
    expect(updated.a).toBe(4);
    expect(updated.b).toBe(2);
    expect(updated.c()).toBe(6);
    expect(val.a).toBe(1);
    expect(val.b).toBe(2);
    expect(val.c()).toBe(3);
}, 1000000);

describe('Creates (& cleans up) VarStore state against Supabase', () => {
    const jsos = new JsosSession().addInMemory().addSupabaseFromEnv();
    beforeEach(async () => {
      await jsos.deleteVar({ name: "myNullTestVar" });
      await jsos.deleteVar({ name: "myTestVar" });
      await jsos.deleteVar({ name: "myTestVar2" });
    }, 1000000);

    function sleep(ms: number) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    test("Var basics against Supabase", async () => {
        const v0 = await jsos.newVar({ name: "myNullTestVar", val: null})
        expect(v0.__jsosVarObj).toBe(null);
        expect(v0).toBeDefined();
        const v1 = await jsos.newVar({ name: "myTestVar", val: [1, 2, 3] });
        //const v2: any = await GetVar("myVar", null, undefined, undefined, false);
        const v2 = await jsos.getVar({ name: "myTestVar" });
        expect(v2).toBeDefined();
        if (v2) {
            expect(v1.__jsosEquals(v2)).toBe(true);
        }
        //expect(NewVar({ // test to be sure creating Var from existing Val works.
        //    name: "myTestVar",
        //    val: await NewVal({ object: [1, 2, 3] }),
        //})).rejects.toThrow();
        const v3 = await jsos.newVar({
            name: "myTestVar2",
            val: await NewVal({ object: [1, 2, 3] })
        });
        expect(v3).toBeDefined();
        expect(v3.__jsosSha1).toEqual(v1.__jsosSha1);
        await v3.__jsosUpdate((oldVar: Array<number>) => [
            ...oldVar,
            4,
        ]);
        expect(v3.length).toBe(4);
        // Test transparent syncing of mutating operations on Var.
        expect(v1[0]).toBe(1);
        v1[3] = 4;
        expect(v1[3]).toBe(4);
        expect(v1.length).toBe(4);
        // i think Jest is mucking with filesystem flushing so that
        // the VarStore subscriptions aren't working as expected
        // when using FileSystemVarStore.
        await sleep(1000); // With supabase, 500ms wasn't enough time.
        //expect(v2.length).toBe(4);
        //const v4 = await GetOrNewVar({
        //    name: "appData",
        //    namespace: "benw-trivia",
        //    defaultVal: null
        //});
    }, 10000000);

    test("Var without autoPullUpdates against Supabase", async () => {
        const w = await jsos.newVar({ name: "myTestVar", val: [1, 2, 3] });
        const otherW = await jsos.getVar<typeof w>({ name: "myTestVar", autoPullUpdates: false });
        w[0] = 100;
        await sleep(500);
        expect(otherW).toBeDefined();
        if (otherW) { // Typeguard
            expect(otherW[0]).toBe(1);
            await otherW.__jsosPull();
            await sleep(1500);
            expect(otherW[0]).toBe(100);
        }
    });

    test("ImmutableVar against Supabase", async () => {
        const immut = await jsos.newImmutableVar({ name: "myTestVar", val: [1, 2, 3] });
        expect("__jsosIsImmutableVar" in immut).toBe(true);
        expect(() => {
            immut[0] = 5;
            console.log("immut var updated:" + immut[0]);
        }).toThrow();
        const newImmut = await immut.__jsosUpdate((oldVal: Array<number>) => [...oldVal, 4]);
        expect(newImmut.length).toEqual(4);
        expect(immut.length).toEqual(3);
    });

    test("POJO prototype chain stored with vals", async () => {
        interface ParentType {
            a: number,
            plusA: (x: number) => number,
            parentNonEnum?: string
        }
        const parent: ParentType = {
            a: 1,
            plusA: function (x: number): number { return x + this.a; }
        };
        expect(parent.plusA(2)).toBe(3);
        interface ChildType extends ParentType {
            b: number,
            aPlusB: () => number,
            childNonEnum?: string
        }
        const child: ChildType = Object.create(parent);
        child.b = 2
        child.aPlusB = function (): number { return this.a + this.b }
        expect(child.plusA(3)).toBe(4);
        expect(child.aPlusB()).toBe(3);
        Object.defineProperty(parent, "parentNonEnum", {
            value: "parentNonEnum", enumerable: false, writable: false
        }); 
        Object.defineProperty(child, "childNonEnum", { value: "childNonEnum", enumerable: false }); 
        expect(child["parentNonEnum"]).toBe("parentNonEnum");
        expect(child["childNonEnum"]).toBe("childNonEnum");
        const v = await jsos.newVar({ name: "myTestVar", val: child });
        expect(v.aPlusB()).toBe(3);
        //expect(v["parentNonEnum"]).toBe("parentNonEnum");
        //expect(v["childNonEnum"]).toBe("childNonEnum");
        const v2 = await jsos.getVar<typeof v>({ name: "myTestVar" });
        expect(v2?.aPlusB()).toBe(3);
        //expect(v2?.["parentNonEnum"]).toBe("parentNonEnum");
        //expect(v2?.["childNonEnum"]).toBe("childNonEnum");
        //expect(Object.getOwnPropertyDescriptor(v2, "childNonEnum")?.enumerable).toBe(false);
        // TODO: Add support for:
        //     - non-enumerable properties
        //     - classes
        //     - contructor information
        //     - getters & setters
        // ... possibly via a new encoder type.
        // 
    }, 10000000);

    test("var created from classes with inheritance", async () => {
        class Parent {
            constructor(public a: number) {}
            plusA(x: number): number { return x + this.a }
        }
        class Child extends Parent {
            constructor(a: number, public b: number) { super(a) }
            aPlusB(): number { return this.a + this.b }
        }
        const v3 = await jsos.newVar({ name: "myTestVar2", val: new Child(10, 20) })
        expect(v3?.aPlusB()).toBe(30);
    }, 10000000);
});
