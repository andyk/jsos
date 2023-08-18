import { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import {
    Collection,
    List,
    Map as ImmutableMap,
    Set as ImmutableSet,
    OrderedMap,
    OrderedSet,
    Stack,
    Record,
} from "immutable";
import { v4 as uuidv4 } from "uuid";
import * as fs from "fs";
import lockfile from "proper-lockfile";
import hash from "object-hash";
import supabase from "./supabase";
import { Mutex } from "async-mutex";
import _ from "lodash";
import { createStore, get, set, del } from "idb-keyval/dist/index.cjs";

// WARNING: probably want be very careful what we use the referenceCache for
// since references are shared and mutable so cached values of them
// are likely to be come stale & incorrect. We may want to get rid of the
// referenceCache entirely.

/*
=============================================================
=================== JSOS - Key Abstractions =================
=============================================================

== JValue ==
The type of objects that this library handles: including aribrarily nested 
arrangements of any Json types or Immutable.Collections

== getSha256() ==
returns the hash of an object, which is always used as an address in ValueStores

== ObjectStore ==
Represents the lowest layer backing store for Values. Provides low-level
functions to store and retrieve JSON from a backing store. The backing store
could be an RDBMS, a document store, a file, an in-memory data structure, etc.
Objects are stored with the hash value of the JSON as the key. ObjectStores do not
contain Logic for encoding/decoding types that are not JSON-native (i.e. types
besides {Array/Plain Object/primitive}) to/from Json. A ObjectStore may wrap a
storage engine that uses a non-JSON format for the actual underlying storage
(e.g., BSON, an RDBMS, etc.) but the key used to store the data is always a
sha256 hash of the JSON representation of the object that is passed into the
ObjectStore.

== ValueStore ==
A ValueStore wraps an array of ObjectStores to make them more user friendly by...
    1) allowing more types to be stored than just JSON (via an Encoder)
    2) it may also decide to break a single object into more than one object in
       the underlying ObjectStore (e.g., to normalize the object).
Thus, a ValueStore has a ObjectStore member, an EncoderDecoder member, and
methods for getting and putting Values.

== VariableStore ==
A data store that provides transactional key-value access using optimistic
concurrency control. Key is (name: string, namespace: string | null), value
is the hash of a Value. A VariableStore is associated with exactly one ValueStore
which is where a Variable's hash can be used to fetch the object that the
Variable currently refers to.

== Value ==
Immutable abstration with persistence. Wraps a JValue (i.e., primitives and/or
Immutables.Collections)
For v0: we use toJS() and fromJS() to convert between Immutable and JS objects
        which throws means any Map and Array types are converted to Immutable.Map
        and Immutable.List types respectively and the original mix of plain JS
        List and Map types are lost.

== Variable ==
A shared mutable named reference to a Value. This is essentially a
(name: string, namespace: string | null, sha256: string) tuple and some helper functions
for updating & syncing that tuple with the database. As the Variable is updated,
the reference is updated in the database.
*/

type Primitive = string | number | boolean | null;
type NormalizedJson =
    | string
    | number
    | boolean
    | null
    | { [key: string]: Primitive }
    | Primitive[];
type Json = Primitive | { [key: string]: Json } | Json[];
type EncodedNormalized = [
    string,
    { objectSha256: string; manifest: Array<string> }
];
type VariableUpdateCallback = (
    name: string,
    namespace: string | null,
    oldSha256: string | null,
    newSha256: string
) => void;

const LOCKFILE_OPTIONS = { retries: 10 };
const OBJECT_STORE_NAME = "JsosObjectStore";
const OBJECT_STORE_FILE_PATH = `./${OBJECT_STORE_NAME}.json`;
const VARIABLE_STORE_PATH = "JsosVariableStore";
const VARIABLE_STORE_FILE_PATH = `./${VARIABLE_STORE_PATH}.json`;
const VALUE_REF_PREFIX = "~#jVal:";
const VARIABLE_STR_KEY_PREFIX = "~#jVar";
const STR_KEY_SEP = "~#~#~";
const DEFAULT_OBJECTS_TABLE_NAME = "jsos_objects";
const DEFAULT_VARIABLES_TABLE_NAME = "jsos_variables";

// Re-using special strings for encoding immutables from
// https://github.com/glenjamin/transit-immutable-js
const IMMUTABLE_MAP_KEY = "~#iM";

const LIST_KEY = "~#iL";
const IMMUTABLE_SET_KEY = "~#iS";
const ORDERED_MAP_KEY = "~#iOM";
const ORDERED_IMMUTABLE_SET_KEY = "~#iOS";
const STACK_KEY = "~#iStk";
const RECORD_KEY = "~#iR";
const DATE_KEY = "~#jD";
const REGEXP_KEY = "~#jR";

const BUILTIN_MAP_KEY = "~#bM";
const BUILTIN_SET_KEY = "~#bS";
const NORMALIZED_OBJECT_KEY = "~#jN";
const VARIABLE_PARENT_KEY = "~#jVP";

function isPrimitive(value: any): value is Primitive {
    return (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
    );
}

function isPrimitiveArray(value: any): value is Primitive[] {
    return Array.isArray(value) && value.every(isPrimitive);
}

function isNormalizedJsonObject(
    value: any
): value is { [key: string]: Primitive } {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;

    return Object.values(value).every(isPrimitive);
}

function isNormalizedJson(value: any): value is NormalizedJson {
    return (
        isPrimitive(value) ||
        isPrimitiveArray(value) ||
        isNormalizedJsonObject(value)
    );
}

function isEncodedNormalized(obj: any): obj is EncodedNormalized {
    return (
        Array.isArray(obj) &&
        obj.length === 2 &&
        obj[0] === NORMALIZED_OBJECT_KEY &&
        typeof obj[1] === "object" &&
        typeof obj[1].objectSha256 === "string" &&
        Array.isArray(obj[1].manifest)
    );
}

function isCustomStorageEvent(
    event: Event
): event is CustomEvent<CustomStorageDetail> {
    return (
        "detail" in event &&
        typeof (event as CustomEvent<CustomStorageDetail>).detail.key ===
            "string"
    );
}

// TODO: cache sha256's in memory using object identity as key
export function getSha256(o: any): string {
    return hash(o, { algorithm: "sha256", encoding: "hex" });
}

function _isValRef(obj: any) {
    return obj && typeof obj === "string" && obj.startsWith(VALUE_REF_PREFIX);
}

function _toValRef(obj: any): string {
    return `${VALUE_REF_PREFIX}${getSha256(obj)}`;
}

function _sha265FromValRef(ref: string): string {
    return ref.slice(VALUE_REF_PREFIX.length);
}

function _toVarKey(name: string, namespace: string | null) {
    if (name.includes(STR_KEY_SEP)) {
        throw new Error(`Variable name cannot contain ${STR_KEY_SEP}`);
    }
    if (namespace?.includes(STR_KEY_SEP)) {
        throw new Error(`Variable namespace cannot contain ${STR_KEY_SEP}`);
    }
    return `${VARIABLE_STR_KEY_PREFIX}${STR_KEY_SEP}${name}${STR_KEY_SEP}${
        namespace || ""
    }`;
}

// Key of VALUE_STR_KEY_PREFIX and nothing else is
function _fromVarKey(key: string | null) {
    if (typeof key !== "string") {
        throw new Error(`Invalid variable key: ${key}`);
    }
    const [prefix, name, namespace] = key.split(STR_KEY_SEP);
    if (prefix !== VARIABLE_STR_KEY_PREFIX || !name) {
        throw new Error(`Invalid variable key: ${key}`);
    }
    return { name, namespace: namespace || null };
}

// A key-value store for storing plain objects using sha256 as key. Can be backed
// by in-memory, file-system, browser Local Storage or IndexedDB, server-based.
abstract class ObjectStore {
    // Test if value with provided sha256 exists in this store.
    abstract hasJson(sha256: string): Promise<boolean>;

    // Fetch a Json object from the object store using it's sha256 as the key.
    // Return undefined if no object with that sha256 exists.
    abstract getJson(sha256: string): Promise<Json | undefined>;
    // If network cost/latency is high, you probably want to override this
    // to batch multiple gets into a single network message.
    async getJsons(
        sha256Array: Array<string>
    ): Promise<Array<Json | undefined>> {
        const promises = sha256Array.map(
            async (sha256) => await this.getJson(sha256)
        );
        return await Promise.all(promises);
    }
    async getJsonEntries(
        sha256Array: Array<string>
    ): Promise<Map<string, Json | undefined>> {
        const promises = sha256Array.map(async (sha256) => {
            const value = await this.getJson(sha256);
            const tuple: [string, Json | undefined] = [sha256, value];
            return tuple;
        });
        const results = await Promise.all(promises);
        return new Map(results);
    }

    // Store a Json object in the object store, return the key that can
    // be used to retrieve it.
    abstract putJson(object: Json): Promise<string>;
    // If network cost/latency is high, you probably want to override this
    // to batch multiple puts into a single network message.
    async putJsons(objects: Array<Json>): Promise<Array<string>> {
        const promises = objects.map(
            async (object) => await this.putJson(object)
        );
        return await Promise.all(promises);
    }

    // Throws an error if the object with the provided sha256 was not deleted.
    // This function doesn't care if the object existed or not as long as it
    // is not in the store after the call.
    abstract deleteJson(sha256: string): Promise<void>;
    // Throws an error if any of the object with provided sha256s were not deleted.
    // This function doesn't care if the objects existed or not as long as they
    // are not in the store after the call.
    async deleteJsons(sha256Array: Array<string>): Promise<void> {
        const promises = sha256Array.map(async (sha256) => {
            const success = await this.deleteJson(sha256);
        });
        await Promise.all(promises);
    }
}

class MultiObjectStore extends ObjectStore {
    readonly objectStores: Array<ObjectStore>;

    constructor(objectStores: Array<ObjectStore>) {
        if (objectStores.length === 0) {
            throw new Error(
                "MultiObjectStore must have at least one ObjectStore"
            );
        }
        super();
        this.objectStores = objectStores;
    }

    async hasJson(sha256: string): Promise<boolean> {
        for (const objectStore of this.objectStores) {
            if (await objectStore.hasJson(sha256)) {
                return true;
            }
        }
        return false;
    }

    async getJson(sha256: string): Promise<Json | undefined> {
        for (const objectStore of this.objectStores) {
            return await objectStore.getJson(sha256);
        }
    }

    async putJson(object: Json): Promise<string> {
        const promises = this.objectStores.map(async (objectStore) => {
            return objectStore.putJson(object);
        });
        const results = await Promise.all(promises);
        results.reduce((prev, curr) => {
            if (prev !== curr) {
                throw new Error(
                    "Two ValueStores returned different results when putting the same object."
                );
            }
            return curr;
        });
        return results[0];
    }

    async deleteJson(sha256: string): Promise<void> {
        const promises = this.objectStores.map(async (objectStore) => {
            objectStore.deleteJson(sha256);
        });
        return;
    }
}

/*
 * A ValueStore is a key-value store for encoding->normalizing->storing or
 * retrieving->denormalizing->decoding immutable Javascript objects to/from
 * undelying ObjectStores.  An ObjectStore puts and gets JSON objects. A
 * ValueStore is one layer higher in abstraction than an ObjectStore and is
 * responsible for transforming an object of any type into normalized JSON
 * before it is put into the ObjectStore and then performing the inverse
 * transformation (as much as possible) when it is subsequently retrieved.  This
 * is useful for encoding objects that JSON doesn't handle natively, as well as
 * for encoding objects in a way that is more efficient or performant (e.g.,
 * normalizing objects prevents lots of redundant information from being sent
 * over the network).
 *
 * The core functions are:
 *   encode(any): Json  // encodes supported non-JSON types, unsupported types dropped on a per-object-property basis, but an object is always put
 *   decode(Json): any
 *   normalize(Json): Array<NormalizedJson>  // breaks 1 object into >=1, returns outer-most object last
 *   denormalize(Array<[string, NormalizedJson]>): Promise<Json> // sub-objects must have been fetched already
 *   getValue(sha256: string): Promise<any>
 *   putValue(any): Promise<[string, EncodedNormalized]> // wraps normalizeDecodeAndPutValue() and returns just the outermost encoded normalized object and sha256 of it
 *   normalizeDecodePutValue(any): Promise<Array<[string, Json]>>  // returns list of key/values put, outer-most object last. `putValue()` wraps this.
 *
 * Essentially: putValue(obj) = return putJson(encodeNormalized(normalize(encode(obj))))
 *              getValue(sha256) = return decode(denormalize(decodeNormalized(getJson(sha256))))
 *
 * We encode some types that that JSON doesn't handle natively -- such as Map,
 * Set, Date, UUID, and immutables-js Collections -- using the format:
 *    [<special_string>, <well_known_format>].
 */
export class ValueStore {
    objectStore: ObjectStore;

    constructor(objectStore: ObjectStore) {
        this.objectStore = objectStore;
    }

    // Similar to putJson() but first:
    // a) encodes the object to handle common types beyond those supported by vanilla JSON
    // b) normalizes the object into one or more "normalized objects",
    // c) encodes the fact that this is a normalized object
    // d) puts all of the normalized objects and associated sub-objects to this
    //    ValueStore's ObjectStore
    //
    // A normalized object is always flat (never nested) because all objects are
    // stored separately in the object store and referenced by sha256.
    //
    // Example: [{a: {b: ["c", "d"]}}, 2, "three"] would translate into the
    // following entries in the object store (where sha256_<N> is short hand
    // for an actual sha256 hexidecimal string):
    //   sha256_0: "c"
    //   sha256_1: "d"
    //   sha256_3: {b: ["~#jVal:sha256_0", "~#jVal:sha256_1"]}
    //   sha256_4: {a: "~#jVal:sha256_3"}
    //   sha256_5: 2
    //   sha256_2: "three"
    //   sha256_5: ["~#jVal:sha256_4", "~#jVal:sha256_5", "~#jVal:sha256_6"]
    //   sha256_6: ["~#jN", {
    //               objectsha1: "sha256_5", manifest: [
    //                  "sha256_0", "sha256_1", ..., "sha256_5"
    //             ]}]
    //
    // And then the return value of putValue() would be:
    //   Promise<{
    //     sha256: "sha256_6",
    //     object: [
    //       "~#jN",
    //       {
    //          objectSha256: "sha256_5",
    //          manifest: ["sha256_0", "sha256_1", ..., "sha256_5"]
    //       }
    //     ]
    //   }>
    async putValue(object: any): Promise<[string, EncodedNormalized]> {
        const putNormalized = await this.normalizeEncodePutValue(object);
        const encodedAsNormalized = this.encodeNormalized(
            putNormalized.map((pair) => pair[0])
        );
        const encodedAsNormalizedSha256 = await this.objectStore.putJson(
            encodedAsNormalized
        );
        if (putNormalized.length === 0) {
            throw new Error(
                "normalizeEncodePutValue() returned 0 objects but should have returned >0."
            );
        }
        return [encodedAsNormalizedSha256, encodedAsNormalized];
    }

    // Outer-most normalized object is last in the returned array.
    async normalizeEncodePutValue(
        object: any
    ): Promise<Array<[string, NormalizedJson]>> {
        const encoded = this.encode(object);
        const normalized = this.normalize(encoded);
        const manifest = await this.objectStore.putJsons(normalized);
        if (normalized.length !== manifest.length) {
            throw new Error(
                `putJsons() returned ${manifest.length} sha256 strings, but ` +
                    `we expected ${normalized.length} objects to successfully be put.`
            );
        }
        return Array.from(
            { length: normalized.length },
            (_, i): [string, NormalizedJson] => {
                return [manifest[i], normalized[i]];
            }
        );
    }

    // TODO: combine all parallel underlying calls to putJsons() into a single
    // call to putJsons() to improve performance via batching of any potential
    // underlying network calls.
    async putValues(objects: Array<any>): Promise<Array<[string, Json]>> {
        return await Promise.all(
            objects.map(async (object) => await this.putValue(object))
        );
    }

    // Throws an error if the object is not encoded and normalized.  If you
    // fetch an object regardless of its type, use ObjectStore.getJson()
    async getValue(sha256: string): Promise<any> {
        const encodedNormalized = await this.objectStore.getJson(sha256);
        if (!isEncodedNormalized(encodedNormalized)) {
            throw new Error(
                `Expected object to be encoded as normalized but it was not: ${encodedNormalized}`
            );
        }
        const normalized = await this.decodeNormalized(encodedNormalized);
        const denormalized = await this.denormalize(normalized);
        return this.decode(denormalized);
    }

    async getValues(sha256array: Array<string>): Promise<Array<any>> {
        return await Promise.all(
            sha256array.map(async (sha256) => await this.getValue(sha256))
        );
    }

    async getValueEntries(
        sha256array: Array<string>
    ): Promise<Map<string, any>> {
        const tuples = Promise.all(
            sha256array.map(async (sha256) => {
                const tuple: [string, any] = [
                    sha256,
                    await this.getValue(sha256),
                ];
                return tuple;
            })
        );
        return new Map(await tuples);
    }

    // Note that deleting a value does not delete any values that it references.
    // Supporting this functionality will require some thought since other normalized
    // values might also reference [some of] the same nested values as the value
    // being deleted. We would have to maintain a reverse index of all normalized
    // objects to support viral/cascading deletes.
    async deleteValue(sha256: string): Promise<void> {
        await this.objectStore.deleteJson(sha256);
    }

    async deleteValues(sha256Array: Array<string>): Promise<void> {
        await this.objectStore.deleteJsons(sha256Array);
    }

    encode(object: any): Json {
        return this.recursiveEncode(object, new Map<any, any>());
    }

    decode(object: Json): any {
        return this.recursiveDecode(object);
    }

    private recursiveEncode(object: any, visited: Map<any, any>): any {
        let encoded = this.shallowEncode(object);
        // Track objects we've encoded to be sure we don't get stuck in
        // infinite loop when objects have reference loops.
        if (visited.has(object)) {
            return visited.get(object);
        } else {
            visited.set(object, encoded);
        }
        if (encoded !== null && typeof encoded === "object") {
            for (let k in encoded) {
                encoded[k] = this.recursiveEncode(encoded[k], visited);
            }
        }
        return encoded;
    }

    private recursiveDecode(object: any): any {
        let decodedObj;
        if (object && typeof object === "object") {
            if (Array.isArray(object)) {
                decodedObj = [...object];
            } else {
                decodedObj = { ...object };
            }
        } else {
            if (!isPrimitive(object)) {
                throw Error(
                    "recursiveDecode can only handle things with typeof " +
                        "object, string, number, boolean, or null"
                );
            }
            decodedObj = object;
        }
        if (object !== null && typeof object === "object") {
            for (let k in object) {
                decodedObj[k] = this.recursiveDecode(object[k]);
            }
        }
       return this.shallowDecode(decodedObj);
    }

    // Returns a copy of `object` that has been encoded.
    // This function performs shallow encoding of objects,
    // so it needs to be called recursively to handle complex types
    // with nested objects that need encoding.
    //
    // TODO: upgrade to using https://github.com/WebReflection/flatted
    // or https://github.com/ungap/structured-clone for encoding/decoding
    // Date, Boolean, etc. and handling objects w/ circular references.
    private shallowEncode(object: any): any {
        if (object instanceof Date) {
            return [DATE_KEY, object.toISOString()];
        }
        if (object instanceof RegExp) {
            return [REGEXP_KEY, {
                source: object.source,
                flags: object.flags
            }];
        }
        if (object instanceof Map) {
            return [BUILTIN_MAP_KEY, Array.from(object)];
        } else if (object instanceof Set) {
            return [BUILTIN_SET_KEY, Array.from(object as Set<unknown>)];
        } else if (OrderedMap.isOrderedMap(object)) {
            // NOTE: the OrderedMap data structure is special because we have to
            // serialize it as an Array<Array> if we want to guarantee that the
            // order of the keys is preserved because calling toObject() in it
            // returns a JS object which does not preserve key order for integer
            // keys.
            return [
                ORDERED_MAP_KEY,
                (object as OrderedMap<any, any>).toArray(),
            ];
        }
        if (ImmutableMap.isMap(object)) {
            return [
                IMMUTABLE_MAP_KEY,
                (object as ImmutableMap<any, any>).toArray(),
            ];
        }
        if (List.isList(object)) {
            return [LIST_KEY, object.toArray()];
        }
        if (ImmutableSet.isSet(object)) {
            return [IMMUTABLE_SET_KEY, object.toArray()];
        }
        if (OrderedSet.isOrderedSet(object)) {
            return [ORDERED_IMMUTABLE_SET_KEY, object.toArray()];
        }
        if (Stack.isStack(object)) {
            return [STACK_KEY, object.toArray()];
        }
        if (Record.isRecord(object)) {
            throw "Immutable.Record serialization not yet supported.";
            //return [RECORD_KEY, object.toObject()];
        }
        if (Array.isArray(object)) {
            return [...object];
        }
        if (object && typeof object === "object") {
            return { ...object };
        }
        if (!isPrimitive(object)) {
            throw Error(
                "shallowEncode can only handle things with typeof " +
                    "string, number, boolean, null, Date, RegExp, or object (including array)"
            );
        }
        return object;
    }

    private shallowDecode(object: any): any {
        if (object?.[0] === DATE_KEY) {
            return new Date(object[1]);
        }
        if (object?.[0] === REGEXP_KEY) {
            return new RegExp(object[1].source, object[1].flags);
        }
        if (Array.isArray(object)) {
            if (object?.[0] === BUILTIN_MAP_KEY) {
                return new Map(object[1] as Array<any>);
            }
            if (object?.[0] === BUILTIN_SET_KEY) {
                return new Set(object[1] as Array<any>);
            }
            if (object?.[0] === ORDERED_MAP_KEY) {
                return OrderedMap(object[1] as Array<any>);
            }
            if (object?.[0] === IMMUTABLE_MAP_KEY) {
                return ImmutableMap(object[1]);
            }
            if (object?.[0] === LIST_KEY) {
                return List(object[1]);
            }
            if (object?.[0] === IMMUTABLE_SET_KEY) {
                return ImmutableSet(object[1]);
            }
            if (object?.[0] === ORDERED_IMMUTABLE_SET_KEY) {
                return OrderedSet(object[1]);
            }
            if (object?.[0] === STACK_KEY) {
                return Stack(object[1]);
            }
            //if (object?.[0] === RECORD_KEY) {
            //    throw "Immutable.Record deserialization not yet supported.";
            //    return Record(object[1]);
            //}
            return [...object];
        }
        if (object && typeof object === "object") {
            return { ...object };
        }
        if (!isPrimitive(object)) {
            throw Error(
                "shallowDecode can only handle things with typeof " +
                    "string, number, boolean, null, Date, RegExp, " + 
                    "or object (including array). Received: " + object
            );
        }
        return object;
    }

    // Return a copy of the input object (or primitive) where every property
    // that is itself of type "object" is replaced with a "reference" to the
    // sub-subject. In this context, a reference is a special string containing
    // the sha256 of the *normalized sub-object*.  Note that the normalization
    // process is recursive and will break down any object into a DAG of objects
    // where each post-noralized object is uniquely identified by its sha256
    // hash.
    //   - in the case of a primitive or empty object, simply return the input
    //   - in the case of a non-empty object or array, return >1 flat-object/flat-array/primitive
    //
    // Note that this function does does not copy non-enumberable properties.
    // Also all enumerable properties from an objects prorotype chain are copied
    // into the normalized object (and the record of their having come from the
    // prototype chain is lost).
    //
    // The last element of the return value is the outermost one, i.e. the root
    // of the DAG.
    normalize(object: Json): Array<NormalizedJson> {
        const objAccumulator: Array<NormalizedJson> = [];
        this.recursiveNormalize(object, objAccumulator);
        return objAccumulator;
    }

    private recursiveNormalize(
        object: Json,
        objAccumulator: Array<NormalizedJson>
    ): NormalizedJson {
        let normalizedJson: NormalizedJson;
        if (object && typeof object === "object") {
            if (Array.isArray(object)) {
                normalizedJson = [];
            } else {
                normalizedJson = {};
            }
            for (let k in object) {
                //if (typeof (object as any)[k] === "object") {
                (normalizedJson as any)[k] = _toValRef(
                    this.recursiveNormalize((object as any)[k], objAccumulator)
                );
                //} else {
                //    (normalizedJson as any)[k] = (object as any)[k];
                //}
            }
        } else {
            normalizedJson = object;
        }
        objAccumulator.push(normalizedJson);
        return normalizedJson;
    }

    // Reconstructs exactly 1 potentially nested object (or primitive) out of
    // >=1 flat object(s) or primitive(s). This function does not fetch any
    // objects from the ObjectStore, all sub-objects (of type NormalizedJson)
    // necessary to successfully denormalize must be proided in the input Array.
    // Assumes that the root of the DAG is the last element of the input Array.
    denormalize(objects: Array<[string, NormalizedJson]>): Promise<Json> {
        const root = objects[objects.length - 1];
        const rootObj = root[1];
        const lookupMap = new Map(objects);
        return this.recursiveDenormalize(rootObj, lookupMap);
    }

    recursiveDenormalize(
        rootObj: NormalizedJson,
        lookupMap: Map<string, NormalizedJson>
    ) {
        let denormalized: any; // any instead of Json here because of property access via string index (even on arrays) below
        if (isPrimitive(rootObj)) {
            return rootObj;
        }
        if (isPrimitiveArray(rootObj)) {
            denormalized = [...rootObj];
        } else {
            denormalized = { ...rootObj };
        }
        for (let k in denormalized) {
            if (_isValRef(denormalized[k])) {
                const key = _sha265FromValRef(denormalized[k]);
                const subObj = lookupMap.get(key);
                if (subObj === undefined) {
                    throw Error(
                        `recursiveDenormalize() failed to find object with sha256 ${key}. ` +
                            `All of the transitive dependencies must be provided to this function.`
                    );
                }
                denormalized[k] = this.recursiveDenormalize(subObj, lookupMap);
            }
        }
        return denormalized;
    }

    // Assumes that the last element of the input array is the sha256 of the root of the DAG.
    // Also assumes (but does not check or enforce) that all objects with addresses provided
    // in the input array are normalized.
    //
    // NOTE: the sha256 of the root object/value is included in the manifest and
    // also returned as the `objectSha256` property for convenience.
    encodeNormalized(normalizedSha256s: Array<string>): EncodedNormalized {
        return [
            NORMALIZED_OBJECT_KEY,
            {
                objectSha256: normalizedSha256s[normalizedSha256s.length - 1],
                manifest: normalizedSha256s,
            },
        ];
    }

    // Decodes an EncodedNormalized object (or primitive) into an array of NormalizedJson objects.
    // Assumes that the last element of the input array is the sha256 of the root of the DAG.
    async decodeNormalized(
        obj: EncodedNormalized
    ): Promise<Array<[string, NormalizedJson]>> {
        if (!isEncodedNormalized(obj)) {
            throw Error(
                "Not an encoded normalized object: " + JSON.stringify(obj)
            );
        }
        const manifest = obj[1].manifest;
        const gotJsons = await this.objectStore.getJsons(manifest);
        const successfulFetches = gotJsons.filter(
            (json): json is NormalizedJson => isNormalizedJson(json)
        );
        if (successfulFetches.length !== manifest.length) {
            const failedSha256s = manifest.filter(
                (_, index) => gotJsons[index] === undefined
            );
            throw Error(
                "Did not successfully get all normalized objects in manifest " +
                    "from ObjectStore. Failed to get the following sha256s: " +
                    failedSha256s
            );
        }
        const withKeys: Array<[string, NormalizedJson]> = successfulFetches.map(
            (obj, i) => [manifest[i], obj]
        );
        return withKeys;
    }
}

// A key-value store for storing/sharing/updating potentially mutable tuples
// (name, namespace, valueSha256, parentSha256, metaDataSha256). The
// primary key is (name, namespace). Provides atomic transactions for updates via
// Optimistic Concurrency Control. the metaDataSha256 is a Value that is a dictionary
// of {isConst: boolean, isDeleted: boolean} stored in the ValueStore.
//
// TODO: Some namespaces may be "protected", which means that users are not allowed
// create/update/delete variables in those namespaces.
//
// Valid Variable operations:
// 1. create a new variable (name, namespace) not already in store
// 2. update an existing variable with a given valueSha256 (name, namespace, valueSha256)
// TODO: Implement delete...
// 3. delete an existing variable (name, namespace)
//     - by default "soft deleted", which means it is just flagged as deleted
//       but not actually deleted (allowing for undelete) until a new value
//       is set for the same (name, namespace). A soft-deleted Variable
//       maintains its isConst setting.
//     - optionally "hard deleted" which actually deletes it from the backing
//       store. If a Variable is ubsequently reated with the same (name,
//       namespace) after a hard delete, the new Variable will not have the
//       deleted Variable as its parent.
// 4. undelete a (soft deleted) variable (name, namespace).
export abstract class VariableStore {
    // SetVariable Returns true if the Variable was successfully created or
    // updated, false if a tuple already exists with the provided name &
    // namespace but a different sha256 than the provided oldSha256. When trying
    // to create a new Variable, omit the oldSha256 arg. If this returns false,
    // it is up to you to deal with conflicts, which likely will mean: get the
    // most recent version of the variable, perform any merging necessary
    // between the changes you've applied to the underlying value and the
    // changes present in the value that somebody else pushed alrady, and try
    // again.
    abstract getVariable(
        name: string,
        namespace: string | null
    ): Promise<string | undefined>;

    abstract newVariable(
        name: string,
        namespace: string | null,
        valueSha256: string
    ): Promise<boolean>;

    abstract updateVariable(
        name: string,
        namespace: string | null,
        oldSha256: string,
        newSha256: string
    ): Promise<boolean>;

    variableListeners: Map<string, Map<string, VariableUpdateCallback>> =
        new Map();
    subscriptionIdToKey: Map<string, string> = new Map();

    subscribeToUpdate(
        name: string,
        namespace: string | null,
        callbackFn: VariableUpdateCallback
    ): string {
        const uuid = uuidv4();
        const key = _toVarKey(name, namespace);
        if (!this.variableListeners.has(key)) {
            this.variableListeners.set(key, new Map());
        }
        this.variableListeners.get(key)!.set(uuid, callbackFn);
        this.subscriptionIdToKey.set(uuid, key);
        return uuid;
    }

    unsubscribeFromUpdate(subscriptionUUID: string): boolean {
        const key = this.subscriptionIdToKey.get(subscriptionUUID);
        if (!key) {
            return false;
        }
        this.variableListeners.get(key)!.delete(subscriptionUUID);
        this.subscriptionIdToKey.delete(subscriptionUUID);
        return true;
    }

    notifyListeners(
        name: string,
        namespace: string | null,
        oldSha256: string | null,
        newSha256: string
    ): void {
        const key = _toVarKey(name, namespace);
        if (this.variableListeners.has(key)) {
            this.variableListeners.get(key)?.forEach((cb) => {
                cb(name, namespace, oldSha256, newSha256);
            });
        }
    }
}

// A shared mutable object.
//
// Wraps any mutable object, auto-captures mutations to that object by
// creating a new underlying `Value` from the post-mutated object and
// setting __jsosValue to it.
//
// Use cases:
// 1) shared
//   a) remote changes are asyncrously pushed automatically to this Variable
//      causing the underlying Value to be replaced with a new one.
//   b) manual/explicit syncing done via __jsosPull();
// c) const - essentially a snapshot of a named Value at a point in time. Can't
//    be updated. Once a Variable object is set to const, it can't be reverted to
//    a mutable object. You can however, create a new Variable object from the
//    same (name, namespace, valueSha256) tuple that is not a const.
//
// A Variable is intrinsically shared (via optimistic concurrency control)
// but you do have control over:
// 1) who it is shared with (e.g., you can share only with yourself
//    by using only an in-memory VariableStore)
// 2) how conflicts are handled (e.g, pull updates and retry)
//
// When a variable update fails due to a conflict, an error is thrown. You
// can catch it, pull updates, and try again.
//
// If __jsosUpdateMode is false, then the value is not auto-updated when
// changes are pushed to __jsosVariableStore for the (__jsosName,
// __jsosNamespace) key. If it is true, then __jsosValue is
// updated automatically when changes are pushed to __jsosVariableStore
// for the (__jsosName, __jsosNamespace) key.
//
// The level of sharing is determined by who else has access to
// __jsosVariableStore. If that is not a shared database, e.g.: if it
// is an InMemoryStore, then you are only sharing with yourself which should
// povide sufficient control.
//
// We use Optimistic Concurrencey Control, so updates to a variable will
// thow an error if the variable has been changed in
// __jsosVariableStore since this variable last pulled updates from it
// either via subscribing to updates or via calling __jsosPull().
//
export interface Variable {
    __jsosVariableStore: VariableStore;
    __jsosName: string;
    __jsosNamespace: string | null;
    __jsosValue: Value;
    __jsosParentValue: Value;
    // If true, this Variable behaves like a named Value by making it immutable.
    // To make changes one has to update the Variable to make this false.
    __jsosIsConst: boolean;
    __jsosSubscribeToUpdates: boolean;
    // while true, causes local mutations to this variable to fail, though remote
    // changes can still be pulled in. This is a useful guard against accidental
    // updates.
    __jsosIsReadOnly: boolean;
    // Fetch Value from VariableStore and set __jsosValue to it,
    // overwriting whaterver value is there. This will throw an error if
    // __jsosIsConst is true. Pulling updates is useful when
    // __jsosSubscribeToUpdates is false, in which case it gives you
    // control over when to sync this Variable to the shared value.
    __jsosPull(): void;
}

export class InMemoryObjectStore extends ObjectStore {
    private valueMap: Map<string, any>;

    constructor() {
        super();
        this.valueMap = new Map();
    }

    async hasJson(sha256: string): Promise<boolean> {
        return this.valueMap.has(sha256);
    }

    async getJson(sha256: string): Promise<any> {
        return this.valueMap.get(sha256);
    }

    async putJson(object: any): Promise<string> {
        const sha256 = getSha256(object);
        this.valueMap.set(sha256, object);
        return sha256;
    }

    async deleteJson(sha256: string): Promise<void> {
        if (this.valueMap.has(sha256)) {
            this.valueMap.delete(sha256);
        }
    }
}

//export class InMemoryVariableStore extends VariableStore {
//    private variableMap: Map<string, string>;
//    private mutex: Mutex;
//
//    constructor() {
//        super();
//        this.variableMap = new Map();
//        this.mutex = new Mutex();
//    }
//
//    async newVariable {
//
//    }
//
//    async updateVariable(
//        name: string,
//        namespace: string | null,
//        oldSha256: string,
//        newSha256: string
//    ): Promise<boolean> {
//        const key = _toVarKey(name, namespace);
//        await this.mutex.runExclusive(async () => {
//            const currSha256 = this.variableMap.get(key);
//            if (currSha256 !== oldSha256) {
//                console.error(
//                    `provided oldSha256 ${oldSha256} does not match current value in in-memory variableMap ${currSha256}`
//                );
//                return false;
//            }
//            this.variableMap.set(key, newSha256);
//            this.notifyListeners(name, namespace, oldSha256, newSha256);
//        });
//        return true;
//    }
//
//    async getVariable(
//        name: string,
//        namespace: string | null
//    ): Promise<string | undefined> {
//        let result: string | undefined;
//        await this.mutex.runExclusive(async () => {
//            result = this.variableMap.get(`${namespace}:${name}`);
//        });
//        return result;
//    }
//}

// One quirk of using idb-keyval is that per [1] "createStore won't let you create
// multiple stores within the same database. Nor will it let you create a store
// within an existing database... This restriction is due to how IndexedDB
// performs schema migrations. If you need this kind of functionality, see IDB
// on NPM, which covers all the callbacks etc you need to manage multiple
// database connections and updates." Thus, we create a new database for each
// store and use the same store name for each (i.e., this.INDEXEDDB_STORE_NAME)
// [1] https://github.com/jakearchibald/idb-keyval/blob/main/custom-stores.md

// An in-memory cache backed by IndexedDB.
export class BrowserIndexedDBObjectStore extends ObjectStore {
    private readonly databaseName: string;
    private readonly storeName: string;
    private store: ReturnType<typeof createStore>;

    constructor(
        databaseName: string = `${OBJECT_STORE_NAME}DB`,
        storeName: string = "JsosStore"
    ) {
        super();
        this.databaseName = databaseName;
        this.storeName = storeName;
        this.store = createStore(this.databaseName, this.storeName);
    }

    async hasJson(sha256: string): Promise<boolean> {
        return (await this.getJson(sha256)) ? true : false;
    }

    async getJson(sha256: string): Promise<Json> {
        return await get(sha256, this.store);
    }

    async putJson(object: Json): Promise<string> {
        /* Write to memory & asynchronously persist to IndexDB */
        const key = getSha256(object);
        await set(key, object, this.store);
        return key;
    }

    async deleteJson(sha256: string): Promise<void> {
        await del(sha256, this.store);
    }
}

// Define the detail structure for TypeScript
// When we add ability to delete Variables, we might change newValue to type string | null
// or maybe intead we will add a type field to the event that can be "CREATE" | "UPDATE" | "DELETE"
interface CustomStorageDetail {
    key: string;
    oldValue: string | null;
    newValue: string;
}
let isCustomLocalStorageObserverSetup = false;
function setupCustomLocalStorageObserver() {
    if (isCustomLocalStorageObserverSetup) {
        return;
    }

    interface CustomStorageDetail {
        key: string;
        oldValue: string | null;
        newValue: string;
    }

    const originalSetItem = localStorage.setItem.bind(localStorage);
    const originalRemoveItem = localStorage.removeItem.bind(localStorage);

    // Create a custom event function
    function dispatchStorageEvent(
        key: string,
        oldValue: string | null,
        newValue: string
    ) {
        const eventDetail: CustomStorageDetail = {
            key,
            oldValue,
            newValue,
        };

        const event = new CustomEvent<CustomStorageDetail>("customStorage", {
            detail: eventDetail,
        });
        window.dispatchEvent(event);
    }

    // Override localStorage.setItem
    localStorage.setItem = (key: string, value: string): void => {
        const oldValue = localStorage.getItem(key);
        originalSetItem(key, value);
        dispatchStorageEvent(key, oldValue, value);
    };

    // TODO add ability to delete variables from VariableStore
    //// Override localStorage.removeItem
    //localStorage.removeItem = (key: string): void => {
    //    const oldValue = localStorage.getItem(key);
    //    originalRemoveItem(key);
    //    dispatchStorageEvent(key, oldValue, null);
    //};
    isCustomLocalStorageObserverSetup = true;
}

export class BrowserLocalStorageVariableStore extends VariableStore {
    constructor() {
        if (typeof localStorage === "undefined") {
            throw new Error(
                "InBrowserFileStore requires localStorage to be defined"
            );
        }
        super();
        // listen to updates from other tabs & windows
        window.addEventListener("storage", (e: StorageEvent) => {
            console.log(
                "Key Modified:",
                e.key,
                "Old Value:",
                e.oldValue,
                "New Value:",
                e.newValue
            );
            const { name, namespace } = _fromVarKey(e.key);
            if (e.newValue) {
                this.notifyListeners(name, namespace, e.oldValue, e.newValue);
            }
        });

        // listen to updates from this tab
        setupCustomLocalStorageObserver();
        window.addEventListener("customStorage", (e: Event) => {
            if (isCustomStorageEvent(e)) {
                console.log(
                    "Key Modified:",
                    e.detail.key,
                    "Old Value:",
                    e.detail.oldValue,
                    "New Value:",
                    e.detail.newValue
                );
                const { name, namespace } = _fromVarKey(e.detail.key);
                this.notifyListeners(
                    name,
                    namespace,
                    e.detail.oldValue,
                    e.detail.newValue
                );
            }
        });
    }

    async newVariable(
        name: string,
        namespace: string | null,
        sha256: string
    ): Promise<boolean> {
        const currSha256 = await this.getVariable(name, namespace);
        if (currSha256) {
            console.error(
                `variable ${name} already exists in namespace ${namespace}. ` +
                    `Did you mean to use updateVariable() instead?`
            );
            return false;
        }
        localStorage.setItem(_toVarKey(name, namespace), sha256);
        return true;
    }

    async updateVariable(
        name: string,
        namespace: string | null,
        oldSha256: string,
        newSha256: string
    ): Promise<boolean> {
        const currSha256 = await this.getVariable(name, namespace);
        if (currSha256 !== oldSha256) {
            console.error(
                `provided oldSha256 ${oldSha256} does not match current value in in-memory variableMap ${currSha256}`
            );
            return false;
        }
        localStorage.setItem(_toVarKey(name, namespace), newSha256);
        return true;
    }

    async getVariable(name: string, namespace: string | null) {
        return localStorage.getItem(_toVarKey(name, namespace)) || undefined;
    }
}

// An in-memory object store backed by a local file (not available in browser)
export class FileBackedObjectStore extends ObjectStore {
    private cache: { [key: string]: any } = {};
    private objectStoreFileName: string;
    private indexDBStore: ReturnType<typeof createStore> | null;

    constructor(fileName: string = OBJECT_STORE_FILE_PATH) {
        if (typeof window !== "undefined") {
            throw new Error(
                "FileBackedObjectStore is not available in browser"
            );
        }
        super();
        this.objectStoreFileName = fileName;
        this.indexDBStore = null;
        this.load();
    }

    private async load() {
        const fs = require("fs");
        if (fs.existsSync(this.objectStoreFileName)) {
            const cacheData = fs.readFileSync(this.objectStoreFileName, "utf8");
            const result = JSON.parse(cacheData);
            Object.assign(this.cache, result);
        }
    }

    async hasJson(sha256: string): Promise<boolean> {
        return sha256 in this.cache;
    }

    async getJson(sha256: string): Promise<Json> {
        return this.cache[sha256];
    }

    async putJson(object: Json): Promise<string> {
        /* Write to memory & asynchronously persist to IndexDB or FS. */
        const key = getSha256(object);
        this.cache[key] = object;
        await this._flushToFile();
        return key;
    }

    async deleteJson(sha256: string): Promise<void> {
        await del(sha256, this.indexDBStore);
        delete this.cache[sha256];
    }

    private async _flushToFile(): Promise<void> {
        const fs = require("fs");
        try {
            await fs.writeFile(
                this.objectStoreFileName,
                JSON.stringify(this.cache)
            );
        } catch (err) {
            console.error("Error writing to file: ", err);
        }
    }
}

export class FileBackedVariableStore extends VariableStore {
    private variableStoreFileName: string;

    constructor(fileName: string = VARIABLE_STORE_FILE_PATH) {
        if (typeof window !== "undefined") {
            throw new Error(
                "FileBackedObjectStore is not available in browser"
            );
        }
        super();
        this.variableStoreFileName = fileName;
        if (!fs.existsSync(this.variableStoreFileName)) {
            fs.writeFileSync(this.variableStoreFileName, "");
        }
    }

    private readVariableStoreFile(): { [key: string]: string } {
        const file = fs.readFileSync(this.variableStoreFileName, "utf8");
        return JSON.parse(file);
    }

    async newVariable(
        name: string,
        namespace: string | null,
        valueSha256: string
    ): Promise<boolean> {
        const release = await lockfile.lock(
            this.variableStoreFileName,
            LOCKFILE_OPTIONS
        );
        const variableStore = this.readVariableStoreFile();
        const key = _toVarKey(name, namespace);
        if (key in variableStore) {
            console.error(
                `variable ${name} already exists in namespace ${namespace} in ` +
                    `file ${this.variableStoreFileName}. Did you mean to use ` +
                    `updateVariable() instead?`
            );
            return false;
        }
        variableStore[key] = valueSha256;
        fs.writeFileSync(
            this.variableStoreFileName,
            JSON.stringify(variableStore)
        );
        release();
        return true;
    }

    async updateVariable(
        name: string,
        namespace: string | null,
        valueSha256: string
    ): Promise<boolean> {
        const release = await lockfile.lock(
            this.variableStoreFileName,
            LOCKFILE_OPTIONS
        );
        const variableStore = this.readVariableStoreFile();
        const key = _toVarKey(name, namespace);
        if (key in variableStore && variableStore[key] !== valueSha256) {
            return false;
        }
        variableStore[key] = valueSha256;
        fs.writeFileSync(
            this.variableStoreFileName,
            JSON.stringify(variableStore)
        );
        release();
        return true;
    }

    async getVariable(
        name: string,
        namespace: string | null
    ): Promise<string | undefined> {
        const release = await lockfile.lock(
            this.variableStoreFileName,
            LOCKFILE_OPTIONS
        );
        const variableStore = this.readVariableStoreFile();
        release();
        return variableStore[_toVarKey(name, namespace)];
    }
}

class SupabaseObjectStore extends ObjectStore {
    supabaseClient: SupabaseClient;
    objectsTableName: string;
    constructor(
        supabaseClient: SupabaseClient,
        objectsTableName: string = DEFAULT_OBJECTS_TABLE_NAME
    ) {
        super();
        this.supabaseClient = supabaseClient;
        this.objectsTableName = objectsTableName;
    }

    async hasJson(sha256: string): Promise<boolean> {
        if (await this.getJson(sha256)) {
            return true;
        }
        return false;
    }

    async getJson(sha256: string): Promise<Json> {
        const { data: row, error } = await this.supabaseClient
            .from(this.objectsTableName)
            .select("json")
            .eq("sha256", sha256)
            .maybeSingle();
        if (error) {
            throw error;
        }
        if (row) {
            return row.json;
        } else {
            throw new Error(
                `Value with sha256 '${sha256}' not found in database`
            );
        }
    }

    async putJson(object: Json): Promise<string> {
        const sha256 = getSha256(object);
        const { data: row, error } = await this.supabaseClient
            .from(this.objectsTableName)
            .insert({ sha256: sha256, json: object })
            .select("json")
            .maybeSingle();
        if (error) {
            if (error.code === "23505") {
                console.log(
                    `object with sha256 ${sha256} already exists in database.`
                );
                const { data: row, error } = await this.supabaseClient
                    .from(this.objectsTableName)
                    .select("json")
                    .eq("sha256", sha256)
                    .maybeSingle();
                if (error) {
                    throw error;
                }
                if (row) {
                    assertReturnEqualToPutObj(row);
                    return sha256;
                }
                throw new Error(
                    `Value with sha256 ${sha256} already in database but could not be fetched.`
                );
            }
            throw error;
        }
        if (row) {
            assertReturnEqualToPutObj(row);
            return sha256;
        }
        throw new Error(
            `Value ${sha256} was inserted but not successfully returned.`
        );

        function assertReturnEqualToPutObj(row: { json: any }) {
            if (!_.isEqual(row.json, object)) {
                throw new Error(
                    `The Object that was inserted into SupabaseObjectStore ` +
                        `${object} was not the same as the object that was ` +
                        `returned ${row.json}`
                );
            }
        }
    }

    async deleteJson(sha256: string): Promise<void> {
        const { data: row, error } = await this.supabaseClient
            .from(this.objectsTableName)
            .delete()
            .eq("sha256", sha256);
        if (error) {
            console.error("Error deleting object from supabase: ", error);
        }
    }
}

const DEFAULT_VALUE_STORE = new ValueStore(
    new MultiObjectStore([new InMemoryObjectStore()])
);

export class Value {
    __jsosValueStore: ValueStore;
    __jsosSha256: string;
    __jsosObject: any;

    async __jsosUpdateIn(
        indexArray: Array<string | number>,
        updateFn: (oldObject: any) => any
    ): Promise<void> {
        throw Error("Not implemented");
    }

    __jsosSetIn(
        indexArray: Array<string | number>,
        newVal: any
    ): Promise<Value> {
        throw Error("Not implemented");
    }

    async __jsosSet(newVal: any): Promise<Value> {
        this.__jsosObject = this.__jsosValueStore.putValue(newVal);
        return Value.create(newVal);
    }

    async __jsosUpdate(
        updateFn: (currVal: any) => Promise<any>
    ): Promise<Value> {
        const newVal = await updateFn(this.__jsosObject);
        return Value.create(newVal, this.__jsosValueStore);
    }

    private constructor(object: any, sha256: string, valueStore: ValueStore) {
        // TODO: make a deep copy of `object` so ensure it can't be mutated outside of this class
        this.__jsosObject = object;
        this.__jsosValueStore = valueStore;
        this.__jsosSha256 = sha256;
    }

    /* Use create pattern since constructor can't be async */
    static create = async (
        object: any,
        valueStore?: ValueStore
    ): Promise<Value> => {
        const vStore = valueStore ?? DEFAULT_VALUE_STORE;
        const [sha256, obj] = await vStore.putValue(object);
        return new Value(obj, sha256, vStore);
    };

    __jsosIsValue(): true {
        return true;
    }
}

//class SupabaseVariableStore extends VariableStore {
//    supabaseClient: SupabaseClient;
//    variablesTableName: string;
//    //supabaseSubcriptions: { RealtimeChannel[];
//    //__jsosUpdateCallback: VariableUpdateCallback | null;
//    //    updateCallback?: VariableUpdateCallback | null
//    //    this.__jsosUpdateCallback = updateCallback;
//    //    updateCallback?: (newValue: any, newSha256: string) => void
//
//    constructor(
//        supabaseClient: SupabaseClient,
//        variablesTableName: string = DEFAULT_VARIABLES_TABLE_NAME
//    ) {
//        super();
//        this.supabaseClient = supabaseClient;
//        this.variablesTableName = variablesTableName;
//        //this.__jsosSupabaseSubcription = null;
//    }
//
//    //get supabaseSubscription(): RealtimeChannel | null {
//    //    return this.__jsosSupabaseSubcription;
//    //}
//
//    //subscribed(): boolean {
//    //    return (
//    //        this.__jsosSupabaseSubcription !== null &&
//    //        this.__jsosSupabaseSubcription !== undefined
//    //    );
//    //}
//
//    //subscribeToSupabase = async (force: boolean = false) => {
//    //    //Subscribe to updates from supabase.
//    //    if (this.subscribed()) {
//    //        return;
//    //    }
//    //    const remoteSha256 = await this.jsosClient.getSha256FromVariable(
//    //        this.name,
//    //        this.namespace
//    //    );
//    //    if (this.objectSha256 !== remoteSha256) {
//    //        console.debug(
//    //            "remote sha256 for var name " +
//    //                this.name +
//    //                " is " +
//    //                remoteSha256 +
//    //                " but local sha256 is " +
//    //                this.objectSha256
//    //        );
//    //        if (force) {
//    //            console.debug(
//    //                "force=true, so updating local sha256 to match remote sha256."
//    //            );
//    //            this.objectSha256 = remoteSha256;
//    //        } else {
//    //            console.error(
//    //                "force=false, and out of sync w/ remote, so not subscribing " +
//    //                    "to supabase updates. You may want to re-run subscribeToSupabase() " +
//    //                    "with force=true to update the local sha256 to match the remote sha256."
//    //            );
//    //        }
//    //    }
//    //    this.__jsosSupabaseSubcription = await this.jsosClient.supabaseClient
//    //        .channel("any")
//    //        .on(
//    //            "postgres_changes",
//    //            {
//    //                event: "*",
//    //                schema: "public",
//    //                table: this.jsosClient.variablesTableName,
//    //                filter: `name=eq.${this.name}`,
//    //            },
//    //            async (payload) => {
//    //                if (payload.new["namespace"] === this.namespace) {
//    //                    this.objectSha256 = payload.new["object"];
//    //                }
//    //                if (this.updateCallback) {
//    //                    this.updateCallback(
//    //                        await this.get(),
//    //                        payload.new["object"]
//    //                    );
//    //                }
//    //            }
//    //        )
//    //        .subscribe();
//    //    /*.subscribe((status: string, err: Error) => {
//    //            if (status === "TIMED_OUT" || status === "CHANNEL_ERROR") {
//    //                console.error(
//    //                    `Error subscribing to supabase updates for var name ${this.name}: `,
//    //                    status
//    //                );
//    //                if (err) {
//    //                    console.error("Error from supabase subscription: ", err);
//    //                }
//    //                this.#supabaseSubcription = null;
//    //            }
//    //        });
//    //        */
//    //};
//
//    async getVariable(
//        name: string,
//        namespace: string | null = null
//    ): Promise<string | undefined> {
//        let queryBuilder = this.supabaseClient
//            .from(this.variablesTableName)
//            .select("object")
//            .eq("name", name);
//        // Use "is" for NULL and "eq" for non-null
//        queryBuilder =
//            namespace === null
//                ? queryBuilder.is("namespace", namespace)
//                : queryBuilder.eq("namespace", namespace);
//        let { data: row, error } = await queryBuilder.maybeSingle();
//        if (error) {
//            throw error;
//        }
//        if (row) {
//            Object.freeze(row.object);
//            return row.object;
//        }
//    }
//
//    async newVariable(
//        name: string,
//        namespace: string | null,
//        oldSha256: string,
//        sha256: string
//    ): Promise<boolean> {
//        const { data: row, error } = await this.supabaseClient
//            .from(this.variablesTableName)
//            .insert({ name: name, namespace: namespace, object: sha256 })
//            .select("value_sha256")
//            .maybeSingle();
//        if (error) {
//            if (error.code === "23505") {
//                // Reference with name this name, namespace, & `object` already exists in database.
//                const { data: row, error } = await this.supabaseClient
//                    .from(this.variablesTableName)
//                    .select("object")
//                    .eq("name", name)
//                    .eq("namespace", namespace)
//                    .maybeSingle();
//                if (error) {
//                    throw error;
//                }
//                if (row && row.object === sha256) {
//                    return true;
//                }
//                throw new Error(
//                    `Value with sha256 ${sha256} already in database but could not be fetched.`
//                );
//            }
//        }
//        if (row) {
//            return true;
//        }
//    };
//}

//export class Variable implements VariableInterface {
//    /*
//        A Variable has a name, optionally a namespace, and the address (i.e., sha256) of a Value.
//        A variable can be updated to refer to a different Value. This is done via an atomic
//        update to the backing database.
//        By default a Variable is subscribed to Supabase postgres updates to the variable.
//    */
//    __jsosVariableStore: VariableStore;
//    __jsosName: string;
//    __jsosNamespace: string | null;
//    __jsosValue: Value;
//    __jsosParentValue: Value;
//    __jsosSubscribeToUpdates: boolean;
//
//    constructor(
//        variableStore: VariableStore,
//        name: string,
//        namespace: string | null = null,
//        value: Value,
//        parentValue: Value
//    ) {
//        this.__jsosVariableStore = variableStore;
//        this.__jsosName = name;
//        this.__jsosNamespace = namespace;
//        this.__jsosValue = value;
//        this.__jsosParentValue = parentValue;
//    }
//
//    static create = async (
//        jsosClient: JsosClient,
//        name: string,
//        namespace: string | null = null,
//        subscribeToSupabase: boolean = true
//    ): Promise<Variable> => {
//        /* If this variable exists already, fetch & return it. Else create it and
//         * initialize it to wrap Value(null) */
//        const sha256 = await jsosClient.getSha256FromVariable(name, namespace);
//        const parentSha256 =
//            (await jsosClient.getSha256FromVariable(
//                sha256,
//                VARIABLE_PARENT_KEY
//            )) || null;
//        let newVar;
//        if (sha256) {
//            newVar = new Variable(
//                jsosClient,
//                name,
//                sha256,
//                parentSha256,
//                namespace,
//                updateCallback
//            );
//        } else {
//            const nullSha256 = await getSha256(await jsosClient.putValue(null));
//            await jsosClient.putReference(name, namespace, nullSha256);
//            newVar = new Variable(
//                jsosClient,
//                name,
//                nullSha256,
//                null,
//                namespace,
//                updateCallback
//            );
//        }
//        if (subscribeToSupabase) {
//            await newVar.subscribeToSupabase();
//        }
//        return newVar;
//    };
//
//    unsubscribeFromSupabase = async (): Promise<void> => {
//        if (this.subscribed()) {
//            const res = await this.jsosClient.supabaseClient.removeChannel(
//                this.__jsosSupabaseSubcription
//            );
//            if (res === "error" || res === "timed out") {
//                console.error(
//                    "Error unsubscribing from supabase updates: ",
//                    res
//                );
//            }
//            this.__jsosSupabaseSubcription = null;
//        }
//    };
//
//    get = async (): Promise<Value> => {
//        const obj = await this.jsosClient.getValue(this.objectSha256);
//        if (!obj) {
//            throw Error(
//                `Object with sha256 '${this.objectSha256}' not found in database`
//            );
//        }
//        return obj;
//    };
//
//    getParent = async (): Promise<Value> => {
//        const obj = await this.jsosClient.getValue(this.parentSha256);
//        if (!obj) {
//            throw Error(
//                `Parent object with sha256 '${this.parentSha256}' not found in database`
//            );
//        }
//        return obj;
//    };
//
//    set = async (newVal: JValue | Value): Promise<Value> => {
//        /* TODO: We might need to use a lock to handle race conditions between
//         * this function and updates done by the supbase subscription callback. */
//        if (!isValue(newVal)) {
//            newVal = await this.jsosClient.value(newVal);
//        }
//        let queryBuilder = this.jsosClient.supabaseClient
//            .from(this.jsosClient.variablesTableName)
//            .update({ object: newVal.sha256 })
//            .eq("name", this.name)
//            .eq("object", this.objectSha256);
//        // use "is" to test against null and "eq" for non-null.
//        queryBuilder =
//            this.namespace === null
//                ? queryBuilder.is("namespace", this.namespace)
//                : queryBuilder.eq("namespace", this.namespace);
//        const { data: row, error } = await queryBuilder.select().maybeSingle();
//        if (error) {
//            throw error;
//        }
//        if (!row) {
//            const { data: innerRow, error } =
//                await this.jsosClient.supabaseClient
//                    .from(this.jsosClient.variablesTableName)
//                    .update({ object: newVal.sha256 })
//                    .eq("name", this.name)
//                    .eq("namespace", this.namespace)
//                    .select()
//                    .maybeSingle();
//            if (error) {
//                throw error;
//            }
//            if (innerRow) {
//                throw new Error(
//                    `Object with sha256 '${this.objectSha256}' not found in database. ` +
//                        "This variable was probably updated by somebody asynchronously " +
//                        "and the update did not make it back to this copy of the variable. " +
//                        "Is this variable subscribed() to supabase updates? If not you " +
//                        "should subscribe() to supabase updates to avoid this error."
//                );
//            } else {
//                throw new Error(
//                    `No ref found in supabase with name ${this.name} ` +
//                        `and namespace ${this.namespace}. The associated with this variable ` +
//                        `may have been deleted from supabase since you created this variable.`
//                );
//            }
//        } else {
//            this.objectSha256 = newVal.sha256;
//            return newVal;
//        }
//    };
//
//    update = async (updateFn: (currVal: JValue) => JValue) => {
//        /* Updates the entry in supbase for this variable to point to the new value
//        using a postgres transaction to ensure that the object we think is current
//        is the same as what the database thinks is the current object pointed
//        to by this variable. If the object has changed, we throw an error and
//        the caller can try again.
//        */
//        const currVal = await this.get();
//        const parentSha256 = this.objectSha256; // capture this before we change it.
//        const newVal = await currVal.update(updateFn);
//        const childSha256 = getSha256(newVal);
//        const afterSetting = await this.set(newVal);
//        await this.jsosClient.putReference(
//            childSha256,
//            VARIABLE_PARENT_KEY,
//            parentSha256
//        );
//        this.parentSha256 = parentSha256;
//        return afterSetting;
//    };
//}

//export interface PersistentOrderedMap<K, V> {
//    update(key: K, notSetValue: V, updater: (value: V) => V): this;
//    update(key: K, updater: (value: V | undefined) => V | undefined): this;
//    update<R>(updater: (value: this) => R): R;
//    set(key: K, value: V): this;
//    toObject(): { [key: string]: V };
//    equals(other: unknown): boolean;
//    get<NSV>(key: K, notSetValue: NSV): V | NSV;
//    get(key: K): V | undefined;
//}
//
//export class PersistentOrderedMap<K, V> implements PersistentOrderedMap<K, V> {
//    jsosClient: JsosClient;
//    orderedMap: OrderedMap<K, V>;
//    sha256: string;
//    wrappedFunctions = ["set", "setIn"];
//
//    private constructor(
//        jsosClient: JsosClient,
//        orderedMap: OrderedMap<K, V>,
//        sha256: string
//    ) {
//        this.jsosClient = jsosClient;
//        this.orderedMap = OrderedMap(orderedMap);
//        this.sha256 = sha256;
//
//        return new Proxy(this, {
//            get: (target, prop, receiver) => {
//                if (Reflect.has(target, prop)) {
//                    return Reflect.get(target, prop, receiver);
//                } else if (target.wrappedFunctions.includes(prop.toString())) {
//                    return function (...args) {
//                        const method = Reflect.get(
//                            target.orderedMap,
//                            prop,
//                            receiver
//                        ).bind(target.orderedMap);
//                        const newMap = PersistentOrderedMap.create<K, V>(
//                            target.jsosClient,
//                            method(...args)
//                        );
//                        return newMap;
//                    };
//                } else {
//                    return Reflect.get(target.orderedMap, prop, receiver);
//                }
//            },
//        });
//    }
//
//    static create = async <K, V>(
//        jsosClient: JsosClient,
//        ...args
//    ): Promise<PersistentOrderedMap<K, V>> => {
//        const map = OrderedMap<K, V>(...args);
//        const sha256 = getSha256(await jsosClient.putValue(map));
//        return new PersistentOrderedMap(jsosClient, map, sha256);
//    };
//}
//
//export class OldPersistentOrderedMap<K, V> {
//    /*
//    A persistant ordered map that uses Jsos to stores its data in a supabase table.
//    Each value is stored into Jsos as a separate object, and the map stores the
//    sha256 of each value. The map itself is stored as an Array<Array> in Jsos, e.g:
//      [["key1", "~#jVal:acf928ad927..."],["key2", "~#jVal:28cf9ad297a..."], ...]
//    */
//    jsosClient: JsosClient;
//    map: OrderedMap<K, V>;
//    sha256: string;
//
//    private constructor(
//        jsosClient: JsosClient,
//        orderedMap: OrderedMap<K, V>,
//        sha256: string
//    ) {
//        this.jsosClient = jsosClient;
//        this.map = OrderedMap(orderedMap);
//        this.sha256 = sha256;
//    }
//
//    static create = async <K, V>(
//        jsosClient: JsosClient,
//        ...args
//    ): Promise<OldPersistentOrderedMap<K, V>> => {
//        const map = OrderedMap<K, V>(...args);
//        const sha256 = getSha256(await jsosClient.putValue(map.toArray()));
//        return new OldPersistentOrderedMap(jsosClient, map, sha256);
//    };
//
//    async set(key: K, value: V): Promise<OldPersistentOrderedMap<K, V>> {
//        const newMap = OldPersistentOrderedMap.create<K, V>(
//            this.jsosClient,
//            this.map.set(key, value)
//        );
//        return newMap;
//    }
//
//    async setIn(
//        keyPath: Iterable<K>,
//        value: V
//    ): Promise<OldPersistentOrderedMap<K, V>> {
//        const newMap = OldPersistentOrderedMap.create<K, V>(
//            this.jsosClient,
//            this.map.setIn(keyPath, value)
//        );
//        return newMap;
//    }
//
//    async get(key: K): Promise<V | undefined> {
//        return this.map.get(key);
//    }
//
//    async equals(other: OldPersistentOrderedMap<K, V>): Promise<boolean> {
//        // this could alternatively be: this.map.equals(other.map)
//        return this.sha256 === other.sha256;
//    }
//}
