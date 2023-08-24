import { jest } from "@jest/globals";
import _ from "lodash";
import {
    ValStore,
    InMemoryJsonStore,
    InMemoryVarStore,
    VarUpdateCallback,
    Val,
    NewVal,
    ValFromSha256,
    NewVar,
    GetVar,
    DeleteVar,
    Var,
    DEFAULT_VARIABLE_STORE,
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
    const [putSha256, _] = await vs.putVal(om);
    const gotVal = await vs.getVal(putSha256);
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
    expect(await varStore.newVar("name", "namespace", "exampleSha256")).toBe(
        true
    );
    expect(await varStore.newVar("name", "namespace", "exampleSha256")).toBe(
        false
    );
    expect(await varStore.getVar("name", "namespace")).toBe("exampleSha256");
    expect(
        await varStore.updateVar(
            "name",
            "namespace",
            "exampleSha256",
            "newSha256"
        )
    ).toBe(true);
    expect(await varStore.getVar("name", "namespace")).toBe("newSha256");
    expect(
        await varStore.updateVar(
            "name",
            "namespace",
            "wrongCurrentSha256",
            "newSha256"
        )
    ).toBe(false);
    expect(await varStore.getVar("name", "namespace")).toBe("newSha256");
    const callBack: VarUpdateCallback = jest.fn(
        (n, ns, oldSha256, newSha256) => {
            expect(n).toBe("name");
            expect(ns).toBe("namespace");
            expect(oldSha256).toBe("newSha256");
            expect(newSha256).toBe("newerSha256");
        }
    );
    const subscrID = varStore.subscribeToUpdates("name", "namespace", callBack);
    expect(callBack).toBeCalledTimes(0);
    expect(
        await varStore.updateVar(
            "name",
            "namespace",
            "newSha256",
            "newerSha256"
        )
    ).toBe(true);
    expect(callBack).toBeCalledTimes(1);
    expect(varStore.unsubscribeFromUpdates(subscrID)).toBe(true);
    expect(
        await varStore.updateVar(
            "name",
            "namespace",
            "newerSha256",
            "evenNewerSha256"
        )
    ).toBe(true);
    expect(callBack).toBeCalledTimes(1);
});

test("Val basics", async () => {
    const init = [1, 2, 3];
    const v = await NewVal({ object: init });
    expect(v.__jsosValObject).toEqual(init);
    expect(v[0]).toBe(1);
    expect(v[2]).toBe(3);
    expect(v.length).toBe(3);
    expect(v[3]).toBe(undefined);
    const updated = await v.__jsosUpdate((oldVal: Array<number>) => [
        ...oldVal,
        4,
    ]);
    expect(updated.__jsosValObject).toEqual([1, 2, 3, 4]);
    expect(v.__jsosSha256).not.toBe(updated.__jsosSha256);

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
});

describe('Creates supabase state', () => {
    beforeAll(async () => {
      await DeleteVar({ name: "myTestVar" });
    });

    test("Var basics", async () => {
        const init = [1, 2, 3];
        const v = await NewVar({ name: "myTestVar", val: init });
        //const v2: any = await GetVar("myVar", null, undefined, undefined, false);
        const v2 = await GetVar({ name: "myTestVar" });
        expect(v2).toBeDefined();
        expect(v.__jsosEquals(v2)).toBe(true);
        const v3 = await NewVar({ // test to be sure creating Var from existing Val works.
            name: "name2",
            val: await NewVal({ object: [1, 2, 3] }),
        });
        expect(v3).toBeDefined();
        expect(v3.__jsosSha256).toEqual(v.__jsosSha256);
        expect(v[0]).toBe(1);
        v[3] = 4;
        expect(v[3]).toBe(4);
        expect(v.length).toBe(4);
        function sleep(ms: number) {
            return new Promise((resolve) => setTimeout(resolve, ms));
        }
        await sleep(7500); // With supabase, 500ms wasn't enough time.
        expect(v2.length).toBe(4);
    }, 10000000);
});

//test('Testing normalized put & get of an array', (done) => {
//    async function test() {
//        const orig = [[2, 22], [1, 11], ["a", "aa"]];
//        const putted = await jsos.putVal(orig);
//        const gotted = await jsos.getPlainVal(getSha1(putted));
//        assert(
//            _.isEqual(orig, gotted),
//            "putJson and getJson are not inverses for a js Array<Array>: " +
//                JSON.stringify(orig) +
//                ", " +
//                JSON.stringify(gotted)
//        );
//        assert(!_.isEqual(orig, putted), "putJson did not normalize input object");
//        done();
//    }
//    test();
//}, 20000);
//
//test('Testing null put & get', (done) => {
//    (async () => {
//        await jsos.putVal(null);
//        const getNull = await jsos.getVal(getSha1(null)); // use cache
//        assert(getNull === null, "put and get null doesn't work.");
//        const getNullIgnoreCache = await jsos.getVal(getSha1(null), true, false); // ignore cache
//        assert(getNullIgnoreCache === null, "put and get null doesn't work when ignoring cache.");
//        done();
//    })();
//}, 60000);
//
//test('Testing normalized plain object put', (done) => {
//    (async () => {
//        const origObj = {a: "aa", b: "bb"}
//        const puttedObj = await jsos.putVal(origObj);
//        const gottedObj = await jsos.getVal(getSha1(puttedObj));
//        assert(
//            _.isEqual(origObj, gottedObj),
//            "putJson and getJson are not inverses for a JS object: " +
//                JSON.stringify(origObj) +
//                ", " +
//                JSON.stringify(gottedObj)
//        );
//        done();
//    })();
//}, 20000);
//
//test('Test non-normalized object storage', (done) => {
//    (async () => {
//        const orig = [[2, 22], [1, 11], ["a", "aa"]];
//        const notNormalized = await jsos.putVal(orig, false);
//        const gotNotNormalized = await jsos.getVal(
//            getSha1(notNormalized),
//            false
//        );
//        assert(
//            _.isEqual(orig, notNormalized) && _.isEqual(orig, gotNotNormalized),
//            "putJson did not return input object when normalize=false: " +
//                JSON.stringify(orig) +
//                ", " +
//                JSON.stringify(notNormalized) +
//                ", " +
//                JSON.stringify(gotNotNormalized)
//        );
//        done();
//    })();
//}, 20000);
//
//test('Testing Val', (done) => {
//    (async () => {
//        const obj = await jsos.value({ a: "aa", b: true, c: [1, "2"], d: { e: ["f", 3, "4"] } });
//        const gotObj = await jsos.getVal(obj.sha1);
//        assert(_.isEqual(obj, gotObj), "object put and get were not inverses: " + JSON.stringify(obj) + ", " + JSON.stringify(gotObj));
//
//        // gotObj.set("g", "gg");
//        done();
//    })();
//}, 20000);
//
//test('Testing PersistentOrderedMap', (done) => {
//    (async () => {
//        /*
//        let x = await jsos.orderedMap<string, string>({ a: "aa" });
//        console.log(await x.get("a"));
//        let y = jsos.getSha1(x);
//        console.log(y);
//        */
//
//        const orig = [[2, 22], [1, 11], ["a", "aa"]];
//        const om = await jsos.persistentOrderedMap(orig);
//        const otherOm = await jsos.getPersistentOrderedMap(om.sha1)
//        assert(
//            otherOm && om.orderedMap.equals(otherOm.orderedMap) && om.equals(otherOm),
//            "orderedMap put and get were not inverses: " +
//                JSON.stringify(om.orderedMap) +
//                ", " +
//                JSON.stringify(otherOm?.orderedMap || null)
//        );
//        const newOm = await om.set("b", "bb");
//        const newOtherOm = await jsos.getPersistentOrderedMap(newOm.sha1)
//        assert(
//            newOtherOm && newOm.orderedMap.equals(newOtherOm.orderedMap) && newOm.equals(newOtherOm),
//            "orderedMap set and get were not inverses: " +
//                JSON.stringify(newOm.orderedMap) +
//                ", " +
//                JSON.stringify(newOtherOm?.orderedMap || null)
//        );
//        done();
//    })();
//}, 60000);
//
//test('Testing nested PersistentOrderedMap', (done) => {
//    (async () => {
//        const om = await jsos.persistentOrderedMap<string, OrderedMap<string, string>>([["agent1", OrderedMap([["Goal", "learn about AI"], ["Wiki", "ai"]])]]);
//        //const om2 = await om.update("agent1", thought => thought.set("goal2", "Have a rich family life"));
//        const omSetted = await om.set("new", OrderedMap([["NewGoal", "learn even more about AI"]]));
//        const gotNested = await jsos.getPersistentOrderedMap<string, OrderedMap<string, string>>(omSetted.sha1)
//        assert(
//            gotNested && gotNested.equals(omSetted),
//            "orderedMap put and get were not inverses"
//        )
//        assert(gotNested?.get("agent1")?.toArray()[0][0] === "Goal", "nested orderedMap getting a set value failed");
//        done();
//    })();
//}, 60000);
//
//test('Testing Cache', (done) => {
//    (async () => {
//        const tmpDir = tmp.dirSync(({} as tmp.Options));
//        const testCache = new FileBackedMemoryStore(tmpDir.name + "/testCache");
//        const testKey = "testKey";
//        const testObj = {a: "aa", b: "bb"};
//        testCache.put(testKey, testObj);
//        assert(_.isEqual(testCache.get(testKey), testObj), "Cache put and get were not inverses");
//        done();
//    })();
// });
//
//test('Testing Var operations', (done) => {
//    (async () => {
//        //http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
//        const randStr = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
//        const variable = await jsos.variable(randStr);
//        assert(variable.subscribed(), "Var did not subscribe to supabase.");
//        let shouldBeNull = await variable.get();
//        assert(shouldBeNull.object === null, "variable get for null value failed");
//        await variable.set(["a string"]);
//        const gotVar = await variable.get();
//        assert(_.isEqual(gotVar.object, ["a string"]), "Var.set() did not work.");
//        await variable.update(oldVal => {
//            return [...(oldVal as Array<string>), "another string"]
//        });
//        const gotAgain = await variable.get();
//        assert(_.isEqual(gotAgain.object, ["a string", "another string"]), "Var.update() did not work.");
//        await variable.unsubscribeFromSupabase();
//        assert(!variable.subscribed(), "Var.unsubscribeFromSupabase() did not work.");
//        //Sleep to give supabase time to cleanup the websocket connection
//        function sleep(ms: number) {
//            return new Promise(resolve => setTimeout(resolve, ms));
//        }
//        async function delayedFunction() {
//            await sleep(300);
//        }
//        await delayedFunction();
//        done();
//    })();
//}, 10000);
