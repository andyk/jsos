import jsos, { getSha1 } from "../src/jsos";
import { OrderedMap } from "immutable";
import _ from "lodash";

function assert(condition, message) {
    if (!condition) {
        throw new Error(message || "Assertion failed");
    }
}

test('Testing normalized array object put & get', async () => {
    const orig = [[2, 22], [1, 11], ["a", "aa"]];
    const putted = await jsos.putObject(orig);
    const gotted = await jsos.getObject(getSha1(putted));
    assert(
        _.isEqual(orig, gotted),
        "putJson and getJson are not inverses for a js Array<Array>: " +
            JSON.stringify(orig) +
            ", " +
            JSON.stringify(gotted)
    );
    assert(!_.isEqual(orig, putted), "putJson did not normalize input object");
}, 20000);

test('Testing null put & get', async () => {
    await jsos.putObject(null);
    const getNull = await jsos.getObject(getSha1(null)); // use cache
    assert(getNull === null, "put and get null doesn't work.");
    const getNullIgnoreCache = await jsos.getObject(getSha1(null), true, false); // ignore cache
    assert(getNullIgnoreCache === null, "put and get null doesn't work when ignoring cache.");
}, 60000);

test('Testing normalized plain object put', async () => {
    const origObj = {a: "aa", b: "bb"}
    const puttedObj = await jsos.putObject(origObj);
    const gottedObj = await jsos.getObject(getSha1(puttedObj));
    assert(
        _.isEqual(origObj, gottedObj),
        "putJson and getJson are not inverses for a JS object: " +
            JSON.stringify(origObj) +
            ", " +
            JSON.stringify(gottedObj)
    );
}, 20000);

test('Test non-normalized object storage', async () => {
    const orig = [[2, 22], [1, 11], ["a", "aa"]];
    const notNormalized = await jsos.putObject(orig, false);
    const gotNotNormalized = await jsos.getObject(
        getSha1(notNormalized),
        false
    );
    assert(
        _.isEqual(orig, notNormalized) && _.isEqual(orig, gotNotNormalized),
        "putJson did not return input object when normalize=false: " +
            JSON.stringify(orig) +
            ", " +
            JSON.stringify(notNormalized) +
            ", " +
            JSON.stringify(gotNotNormalized)
    );
}, 20000);

test('Testing PersistentObject', async () => {
    const obj = await jsos.persistentObject({ a: "aa", b: true, c: [1, "2"], d: { e: ["f", 3, "4"] } });
    const gotObj = await jsos.getPersistentObject(obj.sha1);
    assert(_.isEqual(obj, gotObj), "object put and get were not inverses: " + JSON.stringify(obj) + ", " + JSON.stringify(gotObj));

    // gotObj.set("g", "gg");
}, 20000);

test('Testing PersistentOrderedMap', async () => {
    /*
    let x = await jsos.orderedMap<string, string>({ a: "aa" });
    console.log(await x.get("a"));
    let y = jsos.getSha1(x);
    console.log(y);
    */

    const orig = [[2, 22], [1, 11], ["a", "aa"]];
    const om = await jsos.persistentOrderedMap(orig);
    const otherOm = await jsos.getPersistentOrderedMap(om.sha1)
    assert(
        otherOm && om.orderedMap.equals(otherOm.orderedMap) && om.equals(otherOm),
        "orderedMap put and get were not inverses: " +
            JSON.stringify(om.orderedMap) +
            ", " +
            JSON.stringify(otherOm?.orderedMap || null)
    );
    const newOm = await om.set("b", "bb");
    const newOtherOm = await jsos.getPersistentOrderedMap(newOm.sha1)
    assert(
        newOtherOm && newOm.orderedMap.equals(newOtherOm.orderedMap) && newOm.equals(newOtherOm),
        "orderedMap set and get were not inverses: " +
            JSON.stringify(newOm.orderedMap) +
            ", " +
            JSON.stringify(newOtherOm?.orderedMap || null)
    );
}, 60000);

test('Testing nested PersistentOrderedMap', async () => {
    const om = await jsos.persistentOrderedMap<string, OrderedMap<string, string>>([["agent1", OrderedMap([["Goal", "learn about AI"], ["Wiki", "ai"]])]]);
    //const om2 = await om.update("agent1", thought => thought.set("goal2", "Have a rich family life"));
    const omSetted = await om.set("new", OrderedMap([["NewGoal", "learn even more about AI"]]));
    const gotNested = await jsos.getPersistentOrderedMap<string, OrderedMap<string, string>>(omSetted.sha1)
    assert(
        gotNested && gotNested.equals(omSetted),
        "orderedMap put and get were not inverses"
    )
    assert(gotNested?.get("agent1")?.toArray()[0][0] === "Goal", "nested orderedMap getting a set value failed");
}, 60000);

test('Testing Variable', async () => {
    const variable = await jsos.variable("aTestVar")
    let shouldBeNull = await variable.get();
    assert(shouldBeNull.object === null, "variable get for null value failed");
    variable.set(["a string"]);
    variable.update(oldVal => {
        console.log("old val is: ", oldVal);
        return [...(oldVal as Array<string>), "another string"]
   });
}, 600000);