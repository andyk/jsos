import { ValueStore, InMemoryObjectStore } from "../src/jsos";
import { OrderedMap, Set as ImmutableSet } from "immutable";
//import tmp from 'tmp';
import _ from "lodash";

//tmp.setGracefulCleanup();

function assert(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(message || "Assertion failed");
    }
}

function assertEqual(valOne: any, valTwo: any): void {
    assert(
        _.isEqual(valOne, valTwo),
        "assertEqual failed. The following are not equal:\n\n" +
            JSON.stringify(valOne) +
            "\n\n" +
            JSON.stringify(valTwo)
    );
}

test('Basic ObjectStore and ValueStore operations.', (done) => {
    async function test() {
        console.log("output");
        const orig = [[2, 22], [1, 11], ["a", "aa"]];
        const os = new InMemoryObjectStore();
        const key = await os.putJson(orig)
        const gotJson = await os.getJson(key)
        assertEqual(orig, gotJson);
        const vs = new ValueStore(os);
        const encoded = vs.encode(orig);
        const normalized = vs.normalize(encoded);
        assert(normalized.length === 10, "normalized is wrong size")

        const putVal = await vs.putValue(orig);
        console.log("got val: " + putVal)
        const gotVal = await vs.getValue(putVal[0]);
        assertEqual(orig, gotVal);

        done();
    }
    test();
}, 200000000);

test('Test valuestore with immutable types', (done) => {
    async function test() {
        const om = OrderedMap(([[ "a", {inner: ImmutableSet([1, {innerinner: "inin"}])}], ["b", "bb"]]) as any);
        const os = new InMemoryObjectStore();
        const vs = new ValueStore(os);
        const putVal = await vs.putValue(om);
        console.log("got val: " + putVal)
        const gotVal = await vs.getValue(putVal[0]);
        assertEqual(om, gotVal);
        done();
    }
    test();
}, 200000000);

test('encodeNormalized and decodeNormalized.', (done) => {
    async function test() {
        const os = new InMemoryObjectStore();
        const vs = new ValueStore(os);
        const encodedNorm = await vs.encodeNormalized(["key1", "key2"]);
        assertEqual(encodedNorm[1].manifest[0], "key1");
        done();
    }
    test();
}, 20000);

//test('Testing normalized put & get of an array', (done) => {
//    async function test() {
//        const orig = [[2, 22], [1, 11], ["a", "aa"]];
//        const putted = await jsos.putValue(orig);
//        const gotted = await jsos.getPlainValue(getSha1(putted));
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
//        await jsos.putValue(null);
//        const getNull = await jsos.getValue(getSha1(null)); // use cache
//        assert(getNull === null, "put and get null doesn't work.");
//        const getNullIgnoreCache = await jsos.getValue(getSha1(null), true, false); // ignore cache
//        assert(getNullIgnoreCache === null, "put and get null doesn't work when ignoring cache.");
//        done();
//    })();
//}, 60000);
//
//test('Testing normalized plain object put', (done) => {
//    (async () => {
//        const origObj = {a: "aa", b: "bb"}
//        const puttedObj = await jsos.putValue(origObj);
//        const gottedObj = await jsos.getValue(getSha1(puttedObj));
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
//        const notNormalized = await jsos.putValue(orig, false);
//        const gotNotNormalized = await jsos.getValue(
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
//test('Testing Value', (done) => {
//    (async () => {
//        const obj = await jsos.value({ a: "aa", b: true, c: [1, "2"], d: { e: ["f", 3, "4"] } });
//        const gotObj = await jsos.getValue(obj.sha1);
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
//test('Testing Variable operations', (done) => {
//    (async () => {
//        //http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
//        const randStr = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15); 
//        const variable = await jsos.variable(randStr);
//        assert(variable.subscribed(), "Variable did not subscribe to supabase.");
//        let shouldBeNull = await variable.get();
//        assert(shouldBeNull.object === null, "variable get for null value failed");
//        await variable.set(["a string"]);
//        const gotVar = await variable.get();
//        assert(_.isEqual(gotVar.object, ["a string"]), "Variable.set() did not work.");
//        await variable.update(oldVal => {
//            return [...(oldVal as Array<string>), "another string"]
//        });
//        const gotAgain = await variable.get();
//        assert(_.isEqual(gotAgain.object, ["a string", "another string"]), "Variable.update() did not work.");
//        await variable.unsubscribeFromSupabase();
//        assert(!variable.subscribed(), "Variable.unsubscribeFromSupabase() did not work.");
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