import { jest } from "@jest/globals";
import _ from "lodash";
import {
    ValStore,
    InMemoryJsonStore,
    InMemoryVarStore,
    VarUpdateCallback,
    NewVal,
    NewVar,
    GetVar,
    GetOrNewVar,
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
    const vs = new ValStore(js);
    const encoded = vs.encode(orig);
    const normalized = vs.normalize(encoded);
    expect(normalized.length).toBe(10);

    const putVal = await vs.putVal(orig);
    const gotVal = await vs.getVal(putVal[0]);
    expect(orig).toEqual(gotVal);
});

test("Test valuestore with immutable types", async () => {
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

test("encodeNormalized and decodeNormalized.", async () => {
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
    const callBack: VarUpdateCallback = jest.fn(
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

describe('Creates (& cleans up) VarStore state', () => {
    beforeAll(async () => {
      await DeleteVar({ name: "myNullTestVar" });
      await DeleteVar({ name: "myTestVar" });
      await DeleteVar({ name: "myTestVar2" });
    }, 1000000);

    test("Var basics", async () => {
        const v0 = await NewVar({ name: "myNullTestVar", val: null})
        expect(v0.__jsosVarObj).toBe(null);
        expect(v0).toBeDefined();
        const v1 = await NewVar({ name: "myTestVar", val: [1, 2, 3] });
        //const v2: any = await GetVar("myVar", null, undefined, undefined, false);
        const v2 = await GetVar({ name: "myTestVar" });
        expect(v2).toBeDefined();
        expect(v1.__jsosEquals(v2)).toBe(true);
        //expect(NewVar({ // test to be sure creating Var from existing Val works.
        //    name: "myTestVar",
        //    val: await NewVal({ object: [1, 2, 3] }),
        //})).rejects.toThrow();
        const v3 = await NewVar({
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
        function sleep(ms: number) {
            return new Promise((resolve) => setTimeout(resolve, ms));
        }
        // i think Jest is mucking with filesystem flushing so that
        // the VarStore subscriptions aren't working as expected
        // when using FileSystemVarStore.
        //await sleep(500); // With supabase, 500ms wasn't enough time.
        //expect(v2.length).toBe(4);
        //const v4 = await GetOrNewVar({
        //    name: "appData",
        //    namespace: "benw-trivia",
        //    defaultVal: null
        //});
    }, 10000000);
});
