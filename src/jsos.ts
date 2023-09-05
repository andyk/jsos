/// <reference path="../node_modules/idb-keyval/dist/index.d.ts" />
import {
    SupabaseClient,
    RealtimeChannel,
    RealtimePostgresUpdatePayload,
} from "@supabase/supabase-js";
import {
    Collection,
    List,
    Map as ImmutableMap,
    Set as ImmutableSet,
    OrderedMap,
    OrderedSet,
    Stack,
    Record as ImmutableRecord,
} from "immutable";
import { v4 as uuidv4 } from "uuid";
//import * as fs from "fs";
//import path from "path";
import hash from "object-hash";
import supabase from "./supabase";
import { Mutex } from "async-mutex";
import _ from "lodash";
// This line seems to work in some cases (with vite serve dev)
// but not with CRA (i.e. Weback/Babel/Craco)
//import { createStore, get, set, del } from "idb-keyval/dist/index.cjs";
//import { createStore, get, set, del } from "idb-keyval";

/*
=============================================================
=================== JSOS - Key Abstractions =================
=============================================================

== JVal ==
The type of objects that this library handles: including aribrarily nested 
arrangements of any Json types or Immutable.Collections

== getSha1() ==
returns the hash of an object, which is always used as an address in ValStores

== JsonStore ==
Represents the lowest layer backing store for Vals. Provides low-level
functions to store and retrieve JSON from a backing store. The backing store
could be an RDBMS, a document store, a file, an in-memory data structure, etc.
Objects are stored with the hash value of the JSON as the key. JsonStores do not
contain Logic for encoding/decoding types that are not JSON-native (i.e. types
besides {Array/Plain Object/primitive}) to/from Json. A JsonStore may wrap a
storage engine that uses a non-JSON format for the actual underlying storage
(e.g., BSON, an RDBMS, etc.) but the key used to store the data is always a
sha1 hash of the JSON representation of the object that is passed into the
JsonStore.

== ValStore ==
A ValStore wraps an array of JsonStores to make them more user friendly by...
    1) allowing more types to be stored than just JSON (via an Encoder)
    2) it may also decide to break a single object into more than one object in
       the underlying JsonStore (e.g., to normalize the object).
Thus, a ValStore has a JsonStore member, an EncoderDecoder member, and
methods for getting and putting Vals.

== VarStore ==
A data store that provides transactional key-value access using optimistic
concurrency control. Key is (name: string, namespace: string | null), value
is the hash of a Val. A VarStore is associated with exactly one ValStore
which is where a Var's hash can be used to fetch the object that the
Var currently refers to.

== Val ==
Immutable abstration with persistence. Wraps a JVal (i.e., primitives and/or
Immutables.Collections)
For v0: we use toJS() and fromJS() to convert between Immutable and JS objects
        which throws means any Map and Array types are converted to Immutable.Map
        and Immutable.List types respectively and the original mix of plain JS
        List and Map types are lost.

== Var ==
A shared mutable named reference to a Val. This is essentially a
(name: string, namespace: string | null, sha1: string) tuple and some helper functions
for updating & syncing that tuple with the database. As the Var is updated,
the reference is updated in the database.
*/

// TODO: support functions, possibly via https://github.com/yahoo/serialize-javascript
// https://stackoverflow.com/questions/11697863/what-is-the-correct-way-to-serialize-functions-in-javascript-for-later-use
// This one doesn't support functions but uses Lodash's cloneDeepWith() https://github.com/wix-incubator/javascript-serializer

const LOCKFILE_OPTIONS = { retries: 10 };
const OBJECT_STORE_NAME = "JsosJsonStore";
const OBJECT_STORE_FILE_PATH = `./${OBJECT_STORE_NAME}.json`;
const VARIABLE_STORE_PATH = "JsosVarStore";
const VARIABLE_STORE_FILE_PATH = `./${VARIABLE_STORE_PATH}.json`;
const SUBSCRIPTIONS_FOLDER_PATH = "./jsos_var_subscriptions";
const VALUE_REF_PREFIX = "-#jVal:";
const VARIABLE_STR_KEY_PREFIX = "-#jVar";
const STR_KEY_SEP = "-#-#-";
const DEFAULT_OBJECTS_TABLE_NAME = "jsos_objects";
const DEFAULT_VARIABLES_TABLE_NAME = "jsos_vars";
const DEFAULT_OBJECT_KEY_COL = "hash";
const DEFAULT_VARIABLES_OBJECT_KEY_COL = "val_hash";

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

type Primitive = string | number | boolean | null;
type ValRef = `${typeof VALUE_REF_PREFIX}${string}`;
type NormalizedJson = Primitive | { [key: string]: ValRef } | ValRef[];
type Json = Primitive | { [key: string]: Json } | Json[];
type EncodedNormalized = [
    string,
    { objectSha1: string; manifest: Array<string> }
];
export type VarUpdateCallback = (
    name: string,
    namespace: string | null,
    oldSha1: string | null,
    newSha1: string
) => void;
type SyncValUpdateFn = (old: any) => any;
type AsyncValUpdateFn = (old: any) => Promise<any>;
type VarKey = string;
type SubscriptionUUID = string;

function isNotEmptyObject(obj: any): obj is Record<string, any> {
    return Object.keys(obj).length !== 0;
}

function isPrimitive(val: any): val is Primitive {
    return (
        typeof val === "string" ||
        typeof val === "number" ||
        typeof val === "boolean" ||
        val === null
    );
}

function isPrimitiveArray(val: any): val is Primitive[] {
    return Array.isArray(val) && val.every(isPrimitive);
}

function isNormalizedJsonObject(val: any): val is { [key: string]: Primitive } {
    if (typeof val !== "object" || val === null || Array.isArray(val))
        return false;

    return Object.values(val).every(isPrimitive);
}

function isNormalizedJson(val: any): val is NormalizedJson {
    return (
        isPrimitive(val) || isPrimitiveArray(val) || isNormalizedJsonObject(val)
    );
}

function isEncodedNormalized(obj: any): obj is EncodedNormalized {
    return (
        Array.isArray(obj) &&
        obj.length === 2 &&
        obj[0] === NORMALIZED_OBJECT_KEY &&
        typeof obj[1] === "object" &&
        typeof obj[1].objectSha1 === "string" &&
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

// TODO: cache sha1's in memory using object identity as key
export function getSha1(o: any): string {
    return hash(o, { algorithm: "sha1", encoding: "hex" });
}

function _isValRef(obj: any) {
    return obj && typeof obj === "string" && obj.startsWith(VALUE_REF_PREFIX);
}

function _toValRef(obj: any): string {
    return `${VALUE_REF_PREFIX}${getSha1(obj)}`;
}

function _sha265FromValRef(ref: string): string {
    return ref.slice(VALUE_REF_PREFIX.length);
}

function _toVarKey(name: string, namespace: string | null): VarKey {
    if (name.includes(STR_KEY_SEP)) {
        throw new Error(`Var name cannot contain ${STR_KEY_SEP}`);
    }
    if (namespace?.includes(STR_KEY_SEP)) {
        throw new Error(`Var namespace cannot contain ${STR_KEY_SEP}`);
    }
    return `${VARIABLE_STR_KEY_PREFIX}${STR_KEY_SEP}${name}${STR_KEY_SEP}${
        namespace || ""
    }`;
}

// Key of VALUE_STR_KEY_PREFIX and nothing else is
function _fromVarKey(key: VarKey | null): {
    name: string;
    namespace: string | null;
} {
    if (typeof key !== "string") {
        throw new Error(`Invalid var key: ${key}`);
    }
    const [prefix, name, namespace] = key.split(STR_KEY_SEP);
    if (prefix !== VARIABLE_STR_KEY_PREFIX || !name) {
        throw new Error(`Invalid var key: ${key}`);
    }
    return { name, namespace: namespace || null };
}

// A key-val store for storing plain objects using sha1 as key. Can be backed
// by in-memory, file-system, browser Local Storage or IndexedDB, server-based.
abstract class JsonStore {
    // Test if val with provided sha1 exists in this store.
    abstract hasJson(sha1: string): Promise<boolean>;

    // Fetch a Json object from the object store using it's sha1 as the key.
    // Return undefined if no object with that sha1 exists.
    abstract getJson(sha1: string): Promise<Json | undefined>;
    // If network cost/latency is high, you probably want to override this
    // to batch multiple gets into a single network message.
    async getJsons(sha1Array: Array<string>): Promise<Array<Json | undefined>> {
        const promises = sha1Array.map(
            async (sha1) => await this.getJson(sha1)
        );
        return await Promise.all(promises);
    }
    async getJsonEntries(
        sha1Array: Array<string>
    ): Promise<Map<string, Json | undefined>> {
        const promises = sha1Array.map(async (sha1) => {
            const val = await this.getJson(sha1);
            const tuple: [string, Json | undefined] = [sha1, val];
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

    // Throws an error if the object with the provided sha1 was not deleted.
    // This function doesn't care if the object existed or not as long as it
    // is not in the store after the call.
    abstract deleteJson(sha1: string): Promise<void>;
    // Throws an error if any of the object with provided sha1s were not deleted.
    // This function doesn't care if the objects existed or not as long as they
    // are not in the store after the call.
    async deleteJsons(sha1Array: Array<string>): Promise<void> {
        const promises = sha1Array.map(async (sha1) => {
            const success = await this.deleteJson(sha1);
        });
        await Promise.all(promises);
    }
}

class MultiJsonStore extends JsonStore {
    readonly jsonStores: Array<JsonStore>;
    autoCache: boolean;

    constructor(jsonStores: Array<JsonStore>, autoCache: boolean = true) {
        if (jsonStores.length === 0) {
            throw new Error("MultiJsonStore must have at least one JsonStore");
        }
        super();
        this.jsonStores = jsonStores;
        this.autoCache = autoCache;
    }

    async hasJson(sha1: string): Promise<boolean> {
        for (const jsonStore of this.jsonStores) {
            if (await jsonStore.hasJson(sha1)) {
                return true;
            }
        }
        return false;
    }

    async getJson(sha1: string): Promise<Json | undefined> {
        const missingSha1: Array<JsonStore> = [];
        let gotVal: Json | undefined = undefined;
        for (const jsonStore of this.jsonStores) {
            gotVal = await jsonStore.getJson(sha1);
            if (gotVal !== undefined) {
                break;
            } else {
                missingSha1.push(jsonStore);
            }
        }
        // asynchronously put the value into the stores that
        // were checked and missing it. This has the effect of
        // using each store as a cache for the ones that are
        // after it in this.jsonStores.
        if (this.autoCache && typeof gotVal !== "undefined") {
            const foundVal: Json = gotVal;
            missingSha1.map((jsonStore) => {
                jsonStore.putJson(foundVal);
            });
        }
        return gotVal;
    }

    async putJson(object: Json): Promise<string> {
        const promises = this.jsonStores.map(async (jsonStore) => {
            return jsonStore.putJson(object);
        });
        const results = await Promise.all(promises);
        results.reduce((prev, curr) => {
            if (prev !== curr) {
                throw new Error(
                    "Two ValStores returned different results when putting the same object."
                );
            }
            return curr;
        });
        return results[0];
    }

    async deleteJson(sha1: string): Promise<void> {
        const promises = this.jsonStores.map(async (jsonStore) => {
            await jsonStore.deleteJson(sha1);
        });
        return;
    }
}

/*
 * A ValStore is a key-val store for encoding->normalizing->storing or
 * retrieving->denormalizing->decoding immutable Javascript objects to/from
 * undelying JsonStores.  An JsonStore puts and gets JSON objects. A
 * ValStore is one layer higher in abstraction than an JsonStore and is
 * responsible for transforming an object of any type into normalized JSON
 * before it is put into the JsonStore and then performing the inverse
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
 *   getVal(sha1: string): Promise<any>
 *   putVal(any): Promise<[string, EncodedNormalized]> // wraps normalizeDecodeAndPutVal() and returns just the outermost encoded normalized object and sha1 of it
 *   normalizeDecodePutVal(any): Promise<Array<[string, Json]>>  // returns list of key/vals put, outer-most object last. `putVal()` wraps this.
 *
 * Essentially: putVal(obj) = return putJson(encodeNormalized(normalize(encode(obj))))
 *              getVal(sha1) = return decode(denormalize(decodeNormalized(getJson(sha1))))
 *
 * We encode some types that that JSON doesn't handle natively -- such as Map,
 * Set, Date, UUID, and immutables-js Collections -- using the format:
 *    [<special_string>, <well_known_format>].
 */
export class ValStore {
    jsonStore: JsonStore;

    constructor(jsonStore: JsonStore) {
        this.jsonStore = jsonStore;
    }

    // Similar to putJson() but first:
    // a) encodes the object to handle common types beyond those supported by vanilla JSON
    // b) normalizes the object into one or more "normalized objects",
    // c) encodes the fact that this is a normalized object
    // d) puts all of the normalized objects and associated sub-objects to this
    //    ValStore's JsonStore
    //
    // A normalized object is always flat (never nested) because all objects are
    // stored separately in the object store and referenced by sha1.
    //
    // Example: [{a: {b: ["c", "d"]}}, 2, "three"] would translate into the
    // following entries in the object store (where sha1_<N> is short hand
    // for an actual sha1 hexidecimal string):
    //   sha1_0: "c"
    //   sha1_1: "d"
    //   sha1_3: {b: ["~#jVal:sha1_0", "~#jVal:sha1_1"]}
    //   sha1_4: {a: "~#jVal:sha1_3"}
    //   sha1_5: 2
    //   sha1_2: "three"
    //   sha1_5: ["~#jVal:sha1_4", "~#jVal:sha1_5", "~#jVal:sha1_6"]
    //   sha1_6: ["~#jN", {
    //               objectsha1: "sha1_5", manifest: [
    //                  "sha1_0", "sha1_1", ..., "sha1_5"
    //             ]}]
    //
    // And then the return val of putVal() would be:
    //   Promise<{
    //     sha1: "sha1_6",
    //     object: [
    //       "~#jN",
    //       {
    //          objectSha1: "sha1_5",
    //          manifest: ["sha1_0", "sha1_1", ..., "sha1_5"]
    //       }
    //     ]
    //   }>
    async putVal(object: any): Promise<[string, EncodedNormalized]> {
        const putNormalized = await this.encodeNormalizePutVal(object);
        const encodedNormalized = this.encodeNormalized(
            putNormalized.map((pair) => pair[0])
        );
        const encodedNormalizedSha1 = await this.jsonStore.putJson(
            encodedNormalized
        );
        if (putNormalized.length === 0) {
            throw new Error(
                "normalizeEncodePutVal() returned 0 objects but should have returned >0."
            );
        }
        return [encodedNormalizedSha1, encodedNormalized];
    }

    // Outer-most normalized object is last in the returned array.
    async encodeNormalizePutVal(
        object: any
    ): Promise<Array<[string, NormalizedJson]>> {
        const encoded = this.encode(object);
        const normalized = this.normalize(encoded);
        const manifest = await this.jsonStore.putJsons(normalized);
        if (normalized.length !== manifest.length) {
            throw new Error(
                `putJsons() returned ${manifest.length} sha1 strings, but ` +
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
    async putVals(objects: Array<any>): Promise<Array<[string, Json]>> {
        return await Promise.all(
            objects.map(async (object) => await this.putVal(object))
        );
    }

    // Returns undefined if no object with key `sha1` is present.  Throws an
    // error if the object is found but not encoded and normalized.  If you want
    // to fetch a object (regardless of its type) and skip denormalizing and
    // deserializing it, then use JsonStore.getJson() directly.
    async getVal(sha1: string, freeze: boolean = true): Promise<any> {
        const encodedNormalized = await this.jsonStore.getJson(sha1);
        if (typeof encodedNormalized === "undefined") {
            return encodedNormalized
        }
        if (!isEncodedNormalized(encodedNormalized)) {
            throw new Error(
                `Expected object with hash ${sha1} to be encoded as normalized but it was not: ${encodedNormalized}`
            );
        }
        const normalized = await this.decodeNormalized(encodedNormalized);
        const denormalized = await this.denormalize(normalized);
        return this.decode(denormalized, freeze);
    }

    async getVals(sha1array: Array<string>): Promise<Array<any>> {
        return await Promise.all(
            sha1array.map(async (sha1) => await this.getVal(sha1))
        );
    }

    async getValEntries(sha1array: Array<string>): Promise<Map<string, any>> {
        const tuples = Promise.all(
            sha1array.map(async (sha1) => {
                const tuple: [string, any] = [sha1, await this.getVal(sha1)];
                return tuple;
            })
        );
        return new Map(await tuples);
    }

    // Note that deleting a val does not delete any vals that it references.
    // Supporting this functionality will require some thought since other normalized
    // vals might also reference [some of] the same nested vals as the val
    // being deleted. We would have to maintain a reverse index of all normalized
    // objects to support viral/cascading deletes.
    async deleteVal(sha1: string): Promise<void> {
        await this.jsonStore.deleteJson(sha1);
    }

    async deleteVals(sha1Array: Array<string>): Promise<void> {
        await this.jsonStore.deleteJsons(sha1Array);
    }

    encode(object: any): Json {
        return this.recursiveEncode(object, new Map<any, any>());
    }

    decode(object: Json, freeze: boolean = true): any {
        return this.recursiveDecode(object, freeze);
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

    private recursiveDecode(object: any, freeze: boolean = true): any {
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
                decodedObj[k] = this.recursiveDecode(object[k], freeze);
            }
        }
        const decoded = this.shallowDecode(decodedObj);
        if (freeze) {
            Object.freeze(decoded);
        }
        return decoded;
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
            return [
                REGEXP_KEY,
                {
                    source: object.source,
                    flags: object.flags,
                },
            ];
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
        if (ImmutableRecord.isRecord(object)) {
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
                    "or object (including array). Received: " +
                    object
            );
        }
        return object;
    }

    // Return a copy of the input object (or primitive) where every property
    // that is itself of type "object" is replaced with a "reference" to the
    // sub-subject. In this context, a reference is a special string containing
    // the sha1 of the *normalized sub-object*.  Note that the normalization
    // process is recursive and will break down any object into a DAG of objects
    // where each post-noralized object is uniquely identified by its sha1
    // hash.
    //   - in the case of a primitive or empty object, simply return the input
    //   - in the case of a non-empty object or array, return >1 flat-object/flat-array/primitive
    //
    // Note that this function does does not copy non-enumberable properties.
    // Also all enumerable properties from an objects prorotype chain are copied
    // into the normalized object (and the record of their having come from the
    // prototype chain is lost).
    //
    // The last element of the return val is the outermost one, i.e. the root
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
        if (isPrimitive(object)) {
            normalizedJson = object;
        } else {
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
        }
        objAccumulator.push(normalizedJson);
        return normalizedJson;
    }

    // Reconstructs exactly 1 potentially nested object (or primitive) out of
    // >=1 flat object(s) or primitive(s). This function does not fetch any
    // objects from the JsonStore, all sub-objects (of type NormalizedJson)
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
                        `recursiveDenormalize() failed to find object with sha1 ${key}. ` +
                            `All of the transitive dependencies must be provided to this function.`
                    );
                }
                denormalized[k] = this.recursiveDenormalize(subObj, lookupMap);
            }
        }
        return denormalized;
    }

    // Assumes that the last element of the input array is the sha1 of the root of the DAG.
    // Also assumes (but does not check or enforce) that all objects with addresses provided
    // in the input array are normalized.
    //
    // NOTE: the sha1 of the root object/val is included in the manifest and
    // also returned as the `objectSha1` property for convenience.
    encodeNormalized(normalizedSha1s: Array<string>): EncodedNormalized {
        return [
            NORMALIZED_OBJECT_KEY,
            {
                objectSha1: normalizedSha1s[normalizedSha1s.length - 1],
                manifest: normalizedSha1s,
            },
        ];
    }

    // Decodes an EncodedNormalized object (or primitive) into an array of NormalizedJson objects.
    // Assumes that the last element of the input array is the sha1 of the root of the DAG.
    async decodeNormalized(
        obj: EncodedNormalized
    ): Promise<Array<[string, NormalizedJson]>> {
        if (!isEncodedNormalized(obj)) {
            throw Error(
                "Not an encoded normalized object: " + JSON.stringify(obj)
            );
        }
        const manifest = obj[1].manifest;
        const gotJsons = await this.jsonStore.getJsons(manifest);
        const successfulFetches = gotJsons.filter(
            (json): json is NormalizedJson => isNormalizedJson(json)
        );
        if (successfulFetches.length !== manifest.length) {
            const failedSha1s = manifest.filter(
                (_, index) => gotJsons[index] === undefined
            );
            throw Error(
                "Did not successfully get all normalized objects in manifest " +
                    "from JsonStore. Failed to get the following sha1s: " +
                    failedSha1s
            );
        }
        const withKeys: Array<[string, NormalizedJson]> = successfulFetches.map(
            (obj, i) => [manifest[i], obj]
        );
        return withKeys;
    }
}

// A key-val store for storing/sharing/updating potentially mutable tuples
// (name, namespace, valSha1, parentSha1, metaDataSha1). The
// primary key is (name, namespace). Provides atomic transactions for updates via
// Optimistic Concurrency Control. the metaDataSha1 is a Val that is a dictionary
// of {isConst: boolean, isDeleted: boolean} stored in the ValStore.
//
// TODO: Some namespaces may be "protected", which means that users are not allowed
// create/update/delete vars in those namespaces.
//
// Valid Var operations:
// 1. create a new var (name, namespace) not already in store
// 2. update an existing var with a given valSha1 (name, namespace, valSha1)
// TODO: Implement delete...
// 3. delete an existing var (name, namespace)
//     - by default "soft deleted", which means it is just flagged as deleted
//       but not actually deleted (allowing for undelete) until a new val
//       is set for the same (name, namespace). A soft-deleted Var
//       maintains its isConst setting.
//     - optionally "hard deleted" which actually deletes it from the backing
//       store. If a Var is subsequently re-created with the same (name,
//       namespace) after a hard delete, the new Var will not have the
//       deleted Var as its parent.
// 4. undelete a (soft deleted) var (name, namespace).
export abstract class VarStore {
    // returns sha1 of the var if it exists. Else returns undefined.
    abstract getVar(
        name: string,
        namespace: string | null
    ): Promise<string | undefined>;

    // returns true if the var did not exist and was created. Else returns false.
    abstract newVar(
        name: string,
        namespace: string | null,
        valSha1: string
    ): Promise<boolean>;

    // Returns true if the Var was successfully updated, false if a tuple
    // already exists with the provided name & namespace but a different sha1
    // than the provided oldSha1. If this returns false, it is up to you to deal
    // with conflicts, which likely will mean: get the most recent version of
    // the var, perform any merging necessary between the changes you've applied
    // to the underlying val and the changes present in the val that somebody
    // else pushed already, and then try calling updateVar again.  Must
    // (explicitly or implicitly) call notifyListeners() if the update was
    // successful.
    abstract updateVar(
        name: string,
        namespace: string | null,
        oldSha1: string,
        newSha1: string
    ): Promise<boolean>;

    // Return true if the Var was found and deleted. False otherwise.  Must
    // (explicitly or implicitly) call notifyListeners() if the delete was
    // successful.
    abstract deleteVar(
        name: string,
        namespace: string | null
    ): Promise<boolean>;

    // varListeners is a map of varKey (i.e. name, namespace) -> Map<subscriptionUUID, callbackFn>
    varListeners: Map<VarKey, Map<SubscriptionUUID, VarUpdateCallback>> =
        new Map();
    subscriptionIdToVarKey: Map<SubscriptionUUID, VarKey> = new Map();

    // Returns a subscription UUID that can be used to unsubscribe from updates.
    subscribeToUpdates(
        name: string,
        namespace: string | null,
        callbackFn: VarUpdateCallback
    ): SubscriptionUUID {
        const uuid = uuidv4();
        const varKey = _toVarKey(name, namespace);
        if (!this.varListeners.has(varKey)) {
            this.varListeners.set(varKey, new Map());
        }
        this.varListeners.get(varKey)!.set(uuid, callbackFn);
        this.subscriptionIdToVarKey.set(uuid, varKey);
        return uuid;
    }

    unsubscribeFromUpdates(subscriptionUUID: SubscriptionUUID): boolean {
        const key = this.subscriptionIdToVarKey.get(subscriptionUUID);
        if (!key) {
            return false;
        }
        this.varListeners.get(key)!.delete(subscriptionUUID);
        this.subscriptionIdToVarKey.delete(subscriptionUUID);
        return true;
    }

    notifyListeners(
        name: string,
        namespace: string | null,
        oldSha1: string | null,
        newSha1: string
    ): void {
        const key = _toVarKey(name, namespace);
        if (this.varListeners.has(key)) {
            this.varListeners.get(key)?.forEach((cb) => {
                cb(name, namespace, oldSha1, newSha1);
            });
        }
    }
}

export class InMemoryJsonStore extends JsonStore {
    private valMap: Map<string, any>;

    constructor() {
        super();
        this.valMap = new Map();
    }

    async hasJson(sha1: string): Promise<boolean> {
        return this.valMap.has(sha1);
    }

    async getJson(sha1: string): Promise<any> {
        return this.valMap.get(sha1);
    }

    async putJson(object: any): Promise<string> {
        const sha1 = getSha1(object);
        this.valMap.set(sha1, object);
        return sha1;
    }

    async deleteJson(sha1: string): Promise<void> {
        if (this.valMap.has(sha1)) {
            this.valMap.delete(sha1);
        }
    }
}

export class InMemoryVarStore extends VarStore {
    private varMap: Map<string, string>;
    private mutex: Mutex;

    constructor() {
        super();
        this.varMap = new Map();
        this.mutex = new Mutex();
    }

    async getVar(
        name: string,
        namespace: string | null
    ): Promise<string | undefined> {
        return await this.mutex.runExclusive(async () => {
            return this.varMap.get(_toVarKey(name, namespace));
        });
    }

    // returns true if the var did not exist and was created. Else returns false.
    async newVar(
        name: string,
        namespace: string | null,
        valSha1: string
    ): Promise<boolean> {
        const key = _toVarKey(name, namespace);
        return await this.mutex.runExclusive(async () => {
            if (this.varMap.has(key)) {
                return false;
            }
            this.varMap.set(key, valSha1);
            this.notifyListeners(name, namespace, null, valSha1);
            return true;
        });
    }

    async updateVar(
        name: string,
        namespace: string | null,
        oldSha1: string,
        newSha1: string
    ): Promise<boolean> {
        const key = _toVarKey(name, namespace);
        return await this.mutex.runExclusive(async () => {
            const currSha1 = this.varMap.get(key);
            if (currSha1 !== oldSha1) {
                console.error(
                    `provided oldSha1 ${oldSha1} does not match current val in in-memory varMap ${currSha1}`
                );
                return false;
            }
            this.varMap.set(key, newSha1);
            this.notifyListeners(name, namespace, oldSha1, newSha1);
            return true;
        });
    }

    async deleteVar(name: string, namespace: string | null): Promise<boolean> {
        const key = _toVarKey(name, namespace);
        if (!this.varMap.has(key)) {
            return false;
        }
        await this.mutex.runExclusive(async () => {
            this.varMap.delete(key);
        });
        return true;
    }
}

// One quirk of using idb-keyval is that per [1] "createStore won't let you create
// multiple stores within the same database. Nor will it let you create a store
// within an existing database... This restriction is due to how IndexedDB
// performs schema migrations. If you need this kind of functionality, see IDB
// on NPM, which covers all the callbacks etc you need to manage multiple
// database connections and updates." Thus, we create a new database for each
// store and use the same store name for each (i.e., this.INDEXEDDB_STORE_NAME)
// [1] https://github.com/jakearchibald/idb-keyval/blob/main/custom-stores.md

// An in-memory cache backed by IndexedDB.
export class BrowserIndexedDBJsonStore extends JsonStore {
    private readonly databaseName: string;
    private readonly storeName: string;
    private store: any;
    //private store: returntype<typeof createstore>;

    constructor(
        databaseName: string = `${OBJECT_STORE_NAME}DB`,
        storeName: string = "JsosStore"
    ) {
        super();
        this.databaseName = databaseName;
        this.storeName = storeName;
        this.store = null;
    }

    async getStore(): Promise<any> {
        if (!this.store) {
            const idbKeyval = await import('idb-keyval');
            this.store = await idbKeyval.createStore(this.databaseName, this.storeName); 
        }
        return this.store;
    }

    async hasJson(sha1: string): Promise<boolean> {
        return (await this.getJson(sha1)) ? true : false;
    }

    async getJson(sha1: string): Promise<Json> {
        const store = await this.getStore();
        return await store.get(sha1, this.store);
    }

    async putJson(object: Json): Promise<string> {
        /* Write to memory & asynchronously persist to IndexDB */
        const key = getSha1(object);
        const store = await this.getStore();
        await store.set(key, object, this.store);
        return key;
    }

    async deleteJson(sha1: string): Promise<void> {
        const store = await this.getStore();
        await store.del(sha1, this.store);
    }
}

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

    const originalSetItem = localStorage.setItem.bind(localStorage);
    const originalRemoveItem = localStorage.removeItem.bind(localStorage);

    // Create a custom event function
    function dispatchStorageEvent(
        key: string,
        oldVal: string | null,
        newVal: string
    ) {
        const eventDetail: CustomStorageDetail = {
            key,
            oldValue: oldVal,
            newValue: newVal,
        };

        const event = new CustomEvent<CustomStorageDetail>("customStorage", {
            detail: eventDetail,
        });
        window.dispatchEvent(event);
    }

    // Override localStorage.setItem
    localStorage.setItem = (key: string, val: string): void => {
        const oldVal = localStorage.getItem(key);
        originalSetItem(key, val);
        dispatchStorageEvent(key, oldVal, val);
    };

    // TODO add ability to delete vars from VarStore
    //// Override localStorage.removeItem
    //localStorage.removeItem = (key: string): void => {
    //    const oldVal = localStorage.getItem(key);
    //    originalRemoveItem(key);
    //    dispatchStorageEvent(key, oldVal, null);
    //};
    isCustomLocalStorageObserverSetup = true;
}

export class BrowserLocalStorageVarStore extends VarStore {
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
                "Old Val:",
                e.oldValue,
                "New Val:",
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
                    "Old Val:",
                    e.detail.oldValue,
                    "New Val:",
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

    async newVar(
        name: string,
        namespace: string | null,
        sha1: string
    ): Promise<boolean> {
        const currSha1 = await this.getVar(name, namespace);
        if (currSha1) {
            console.error(
                `var ${name} already exists in namespace ${namespace}. ` +
                    `Did you mean to use updateVar() instead?`
            );
            return false;
        }
        localStorage.setItem(_toVarKey(name, namespace), sha1);
        return true;
    }

    async updateVar(
        name: string,
        namespace: string | null,
        oldSha1: string,
        newSha1: string
    ): Promise<boolean> {
        const currSha1 = await this.getVar(name, namespace);
        if (currSha1 !== oldSha1) {
            console.error(
                `provided oldSha1 ${oldSha1} does not match current val in in-memory varMap ${currSha1}`
            );
            return false;
        }
        localStorage.setItem(_toVarKey(name, namespace), newSha1);
        return true;
    }

    async getVar(name: string, namespace: string | null) {
        return localStorage.getItem(_toVarKey(name, namespace)) || undefined;
    }

    async deleteVar(name: string, namespace: string | null): Promise<boolean> {
        const currSha1 = await this.getVar(name, namespace);
        if (!currSha1) {
            return false;
        }
        localStorage.removeItem(_toVarKey(name, namespace));
        return true;
    }
}

// A simple filesystem based JSON store (not available in browser).
export class FileBackedJsonStore extends JsonStore {
    lockfile = require("proper-lockfile");
    fs = require("fs");
    private jsonStoreFileName: string;

    constructor(fileName: string = OBJECT_STORE_FILE_PATH) {
        if (typeof window !== "undefined") {
            throw new Error("FileBackedJsonStore is not available in browser");
        }
        super();
        this.jsonStoreFileName = fileName;
        if (!this.fs.existsSync(this.jsonStoreFileName)) {
            this.fs.writeFileSync(this.jsonStoreFileName, "{}", { flag: "wx" });
        }
    }

    #readJsonStoreFile(): { [key: string]: any } {
        const file = this.fs.readFileSync(this.jsonStoreFileName, "utf8");
        return JSON.parse(file);
    }

    #writeJsonStoreFile(obj: Json): void {
        try {
            this.fs.writeFileSync(this.jsonStoreFileName, JSON.stringify(obj));
        } catch (err) {
            console.error("Error writing to file: ", err);
        }
    }

    async hasJson(sha1: string): Promise<boolean> {
        return sha1 in this.#readJsonStoreFile();
    }

    async getJson(sha1: string): Promise<Json> {
        return this.#readJsonStoreFile()[sha1];
    }

    async putJson(object: Json): Promise<string> {
        /* Write to memory & asynchronously persist to IndexDB or FS. */
        //const release = await this.lockfile.lock(
        //    this.jsonStoreFileName,
        //    LOCKFILE_OPTIONS
        //);
        const key = getSha1(object);
        const jsonStore = this.#readJsonStoreFile();
        jsonStore[key] = object;
        this.#writeJsonStoreFile(jsonStore);
        //release();
        return key;
    }

    async deleteJson(sha1: string): Promise<void> {
        //const release = await this.lockfile.lock(
        //    this.jsonStoreFileName,
        //    LOCKFILE_OPTIONS
        //);
        const jsonStore = this.#readJsonStoreFile();
        delete jsonStore[sha1];
        this.#writeJsonStoreFile(jsonStore);
        //release();
    }
}

// A simple filesystem based Var store (not available in browser).
// Pub-Sub by listeners to variable updates is also handled via the file system
// (i.e. listeners are notified of updates via file system events).
// Each time a listener subscribes to updates for a given var, a file is created
// with the name `SUBSCRIPTIONS_FOLDER/<VAR_KEY>/<SUBSCRIPTION_ID>. Each time a
// var is updated, its corresponding <VAR_KEY> dir is touched which notifies
// all listeners. Each time a
// listener unsubscribes from updates
//export class FileBackedVarStore extends VarStore {
//    fs = require("fs");
//    path = require("path");
//    lockfile = require("proper-lockfile");
//    chokidar = require("chokidar");
//    // the "exit-hook" npm package didn't just work w/ ts-node, whereas this does.
//    exitHook = require("async-exit-hook");
//    private varStoreFileName: string;
//    private subscriptionsFolderPath: string;
//    watchers: Map<SubscriptionUUID, { watcher: any; listenerFileName: string }>;
//
//    constructor(
//        varStoreFilePath: string = VARIABLE_STORE_FILE_PATH,
//        subscriptionsFolderPath: string = SUBSCRIPTIONS_FOLDER_PATH
//    ) {
//        if (typeof window !== "undefined") {
//            throw new Error("FileBackedJsonStore is not available in browser");
//        }
//        super();
//        this.varStoreFileName = varStoreFilePath;
//        if (!this.fs.existsSync(this.varStoreFileName)) {
//            this.fs.writeFileSync(this.varStoreFileName, "{}", { flag: "wx" });
//        }
//        this.subscriptionsFolderPath = subscriptionsFolderPath;
//        if (!this.fs.existsSync(this.subscriptionsFolderPath)) {
//            this.fs.mkdirSync(this.subscriptionsFolderPath, { recursive: true });
//        }
//        this.watchers = new Map();
//        this.exitHook(() => {
//            try {
//                const subFiles = [...this.watchers.values()].map(
//                    (watcher) => watcher.listenerFileName
//                );
//                console.log(
//                    "cleaning up (i.e. deleting) sub files:: ",
//                    subFiles
//                );
//                subFiles.forEach((filename: string) => {
//                    this.fs.unlinkSync(filename);
//                    console.log("deleted", filename);
//                    // DELETE THE FOLDER THAT CONTAINED FILENAME IF IT IS NOW EMPTY
//                    const dir = this.path.dirname(filename);
//                    try {
//                        this.fs.rmdirSync(dir);
//                        console.log(
//                            "deleted empty Var subscription directory ",
//                            dir
//                        );
//                    } catch (error) {
//                        // Ignore error if directory is not empty
//                    }
//                });
//            } catch {
//                // per https://github.com/Tapppi/async-exit-hook/issues/10
//                process.exit(1);
//            }
//        });
//    }
//
//    getListenerFileName(varKey: VarKey, subscriptionUuid: SubscriptionUUID) {
//        return `${this.subscriptionsFolderPath}/${varKey}/${subscriptionUuid}`;
//    }
//
//    resetListenerFile(listenerFileName: string) {
//        const dir = this.path.dirname(listenerFileName);
//        if (!this.fs.existsSync(dir)) {
//            this.fs.mkdirSync(dir, { recursive: true });
//        }
//        const outStream = this.fs.createWriteStream(listenerFileName, "utf8");
//        outStream.write("[]");
//        outStream.end();
//    }
//
//    // Set up a listener to receive notifications of changes to the var store
//    // by others.
//    subscribeToUpdates(
//        name: string,
//        namespace: string | null,
//        callbackFn: VarUpdateCallback
//    ): string {
//        const listenerUuid = super.subscribeToUpdates(
//            name,
//            namespace,
//            callbackFn
//        );
//        const listenerFileName = this.getListenerFileName(
//            _toVarKey(name, namespace),
//            listenerUuid
//        );
//        if (this.fs.existsSync(listenerFileName)) {
//            throw Error(`Subscription file ${listenerFileName} already exists`);
//        }
//        this.resetListenerFile(listenerFileName);
//        const watcher = this.chokidar.watch(listenerFileName);
//        watcher.on("change", (path: string, stats: any) => {
//            const listenerFileContents = this.fs.readFileSync(
//                listenerFileName,
//                "utf8"
//            );
//            const listenerEvents = JSON.parse(listenerFileContents); // Array<[oldSha1: string, newSha1: string]>
//            if (!Array.isArray(listenerEvents)) {
//                throw Error(
//                    `Expected listener file ${listenerFileName} to contain an array of events`
//                );
//            }
//            if (listenerEvents.length === 0) {
//                return;
//            }
//            for (let [oldSha1, newSha1] of listenerEvents) {
//                this.notifyListeners(name, namespace, oldSha1, newSha1);
//            }
//            this.resetListenerFile(listenerFileName);
//        });
//        this.watchers.set(listenerUuid, { watcher, listenerFileName });
//        return listenerUuid;
//    }
//
//    unsubscribeFromUpdates(subscriptionUUID: string): boolean {
//        const success = super.unsubscribeFromUpdates(subscriptionUUID);
//        if (!success) {
//            return false;
//        }
//        const subscription = this.watchers.get(subscriptionUUID);
//        if (subscription) {
//            subscription.watcher.close();
//            if (!this.fs.existsSync(subscription.listenerFileName)) {
//                return false;
//            }
//            this.fs.unlinkSync(subscription.listenerFileName);
//            return true;
//        }
//        return false;
//    }
//
//    private readVarStoreFile(): { [key: string]: string } {
//        const file = this.fs.readFileSync(this.varStoreFileName, "utf8");
//        return JSON.parse(file);
//    }
//
//    // append [oldSha1: string, newSha1: string]> to the JSON array that is in
//    // listenerFileName
//    updateListenerFiles(
//        oldSha1: string | null,
//        newSha1: string,
//        varKey: VarKey
//    ) {
//        const varListenerFolder = `${this.subscriptionsFolderPath}/${varKey}`;
//        try {
//            const files = this.fs.readdirSync(varListenerFolder);
//            for (let subscriptionFile of files) {
//                const filePath = varListenerFolder + "/" + subscriptionFile;
//                const listenerFileContents = this.fs.readFileSync(filePath, "utf8");
//                const listenerEvents = JSON.parse(listenerFileContents); // Array<[oldSha1: string, newSha1: string]>
//                listenerEvents.push([oldSha1, newSha1]);
//                const outStream = this.fs.createWriteStream(filePath, "utf8");
//                outStream.write(JSON.stringify(listenerEvents));
//                outStream.end();
//            }
//        } catch (err: any) {
//            if (err.code !== "ENOENT") {
//                throw err;
//            }
//        }
//    }
//
//    async newVar(
//        name: string,
//        namespace: string | null,
//        valSha1: string
//    ): Promise<boolean> {
//        const release = await this.lockfile.lock(
//            this.varStoreFileName,
//            LOCKFILE_OPTIONS
//        );
//        try {
//            const varStore = this.readVarStoreFile();
//            const varKey = _toVarKey(name, namespace);
//            if (varKey in varStore) {
//                console.error(
//                    `var ${name} already exists in namespace ${namespace} in ` +
//                        `file ${this.varStoreFileName}. Did you mean to use ` +
//                        `updateVar() instead?`
//                );
//                return false;
//            }
//            varStore[varKey] = valSha1;
//            this.fs.writeFileSync(this.varStoreFileName, JSON.stringify(varStore));
//            this.updateListenerFiles(null, valSha1, varKey);
//            return true;
//        } catch (error) {
//            console.error(
//                "An error occurred while creating a new variable:",
//                error
//            );
//            throw error;
//        } finally {
//            release();
//        }
//    }
//
//    async updateVar(
//        name: string,
//        namespace: string | null,
//        oldSha1: string,
//        newSha1: string
//    ): Promise<boolean> {
//        const release = await this.lockfile.lock(
//            this.varStoreFileName,
//            LOCKFILE_OPTIONS
//        );
//        try {
//            const varStore = this.readVarStoreFile();
//            const varKey = _toVarKey(name, namespace);
//            if (varKey in varStore && varStore[varKey] !== oldSha1) {
//                return false;
//            }
//            varStore[varKey] = newSha1;
//            this.fs.writeFileSync(this.varStoreFileName, JSON.stringify(varStore));
//            this.updateListenerFiles(oldSha1, newSha1, varKey);
//            return true;
//        } catch (error) {
//            console.error(
//                "An error occurred while creating a new variable:",
//                error
//            );
//            throw error;
//        } finally {
//            release();
//        }
//    }
//
//    async getVar(
//        name: string,
//        namespace: string | null
//    ): Promise<string | undefined> {
//        const release = await this.lockfile.lock(
//            this.varStoreFileName,
//            LOCKFILE_OPTIONS
//        );
//        try {
//            const varStore = this.readVarStoreFile();
//            return varStore[_toVarKey(name, namespace)];
//        } catch (error) {
//            console.error(
//                "An error occurred while creating a new variable:",
//                error
//            );
//            throw error;
//        } finally {
//            release();
//        }
//    }
//
//    async deleteVar(name: string, namespace: string | null): Promise<boolean> {
//        const release = await this.lockfile.lock(
//            this.varStoreFileName,
//            LOCKFILE_OPTIONS
//        );
//        try {
//            const varStore = this.readVarStoreFile();
//            const key = _toVarKey(name, namespace);
//            if (!(key in varStore)) {
//                return false;
//            }
//            delete varStore[key];
//            this.fs.writeFileSync(this.varStoreFileName, JSON.stringify(varStore));
//            return true;
//        } catch (error) {
//            console.error(
//                "An error occurred while creating a new variable:",
//                error
//            );
//            throw error;
//        } finally {
//            release();
//        }
//    }
//}

class SupabaseJsonStore extends JsonStore {
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

    async hasJson(sha1: string): Promise<boolean> {
        if (await this.getJson(sha1)) {
            return true;
        }
        return false;
    }

    async getJson(sha1: string): Promise<Json> {
        const { data: row, error } = await this.supabaseClient
            .from(this.objectsTableName)
            .select("json")
            .eq(DEFAULT_OBJECT_KEY_COL, sha1)
            .maybeSingle();
        if (error) {
            throw error;
        }
        if (row) {
            return row.json;
        } else {
            throw new Error(`Val with sha1 '${sha1}' not found in database`);
        }
    }

    async putJson(object: Json): Promise<string> {
        const sha1 = getSha1(object);
        const { data: row, error } = await this.supabaseClient
            .from(this.objectsTableName)
            .insert({ [DEFAULT_OBJECT_KEY_COL]: sha1, json: object })
            .select("json")
            .maybeSingle();
        if (error) {
            if (error.code === "23505") {
                console.log(
                    `object with sha1 ${sha1} already exists in database.`
                );
                const { data: row, error } = await this.supabaseClient
                    .from(this.objectsTableName)
                    .select("json")
                    .eq(DEFAULT_OBJECT_KEY_COL, sha1)
                    .maybeSingle();
                if (error) {
                    throw error;
                }
                if (row) {
                    assertReturnEqualToPutObj(row);
                    return sha1;
                }
                throw new Error(
                    `Val with sha1 ${sha1} already in database but could not be fetched.`
                );
            }
            throw error;
        }
        if (row) {
            assertReturnEqualToPutObj(row);
            return sha1;
        }
        throw new Error(
            `Val ${sha1} was inserted but not successfully returned.`
        );

        function assertReturnEqualToPutObj(row: { json: any }) {
            if (!_.isEqual(row.json, object)) {
                throw new Error(
                    `The Object that was inserted into SupabaseJsonStore ` +
                        `${object} was not the same as the object that was ` +
                        `returned ${row.json}`
                );
            }
        }
    }

    async deleteJson(sha1: string): Promise<void> {
        const { data: row, error } = await this.supabaseClient
            .from(this.objectsTableName)
            .delete()
            .eq(DEFAULT_OBJECT_KEY_COL, sha1);
        if (error) {
            console.error("Error deleting object from supabase: ", error);
        }
    }
}

class SupabaseVarStore extends VarStore {
    supabaseClient: SupabaseClient;
    varsTableName: string;
    supabaseSubscription: RealtimeChannel | null;

    constructor(
        supabaseClient: SupabaseClient,
        varsTableName: string = DEFAULT_VARIABLES_TABLE_NAME
    ) {
        super();
        this.supabaseClient = supabaseClient;
        this.varsTableName = varsTableName;
        this.supabaseSubscription = null;
        this.subscribeToSupabase();
    }

    //get supabaseSubscription(): RealtimeChannel | null {
    //    return this.__jsosSupabaseSubcription;
    //}

    subscribedToSupabase(): boolean {
        return (
            this.supabaseSubscription !== null &&
            this.supabaseSubscription !== undefined
        );
    }

    // Returns true if already subscribed or subcribe was successful.
    subscribeToSupabase(): boolean {
        if (this.supabaseSubscription) {
            return true;
        }
        this.supabaseSubscription = this.supabaseClient
            .channel("any")
            .on<{
                name: string;
                namespace: string | null;
                [DEFAULT_VARIABLES_OBJECT_KEY_COL]: string;
            }>(
                "postgres_changes",
                {
                    event: "*",
                    schema: "public",
                    table: this.varsTableName,
                },
                async (payload) => {
                    if (
                        isNotEmptyObject(payload.new) &&
                        isNotEmptyObject(payload.old)
                    ) {
                        if (
                            payload.new.name !== payload.old.name ||
                            payload.new.namespace !== payload.old.namespace
                        ) {
                            throw Error(
                                "Received an illegal update via supabase subscription: " +
                                    `Name and/or namespace changed. ${JSON.stringify(
                                        payload
                                    )}`
                            );
                        }
                        console.log(
                            "SupabaseVarStore Notifying listeners of var update..."
                        );
                        this.notifyListeners(
                            payload.old["name"],
                            payload.old["namespace"],
                            payload.old[DEFAULT_VARIABLES_OBJECT_KEY_COL],
                            payload.new[DEFAULT_VARIABLES_OBJECT_KEY_COL]
                        );
                    }
                }
            )
            .subscribe();
        return true;
        /*.subscribe((status: string, err: Error) => {
                if (status === "TIMED_OUT" || status === "CHANNEL_ERROR") {
                    console.error(
                        `Error subscribing to supabase updates for var name ${this.name}: `,
                        status
                    );
                    if (err) {
                        console.error("Error from supabase subscription: ", err);
                    }
                    this.#supabaseSubcription = null;
                }
            });
            */
    }

    async getVar(
        name: string,
        namespace: string | null = null
    ): Promise<string | undefined> {
        let queryBuilder = this.supabaseClient
            .from(this.varsTableName)
            .select(DEFAULT_VARIABLES_OBJECT_KEY_COL)
            .eq("name", name);
        // Use "is" for NULL and "eq" for non-null
        queryBuilder =
            namespace === null
                ? queryBuilder.is("namespace", namespace)
                : queryBuilder.eq("namespace", namespace);
        const { data: row, error } = await queryBuilder.maybeSingle();
        if (error) {
            throw error;
        }
        if (row) {
            Object.freeze(row[DEFAULT_VARIABLES_OBJECT_KEY_COL]);
            return row[DEFAULT_VARIABLES_OBJECT_KEY_COL];
        }
    }

    async newVar(
        name: string,
        namespace: string | null,
        valSha1: string
    ): Promise<boolean> {
        const { data: row, error } = await this.supabaseClient
            .from(this.varsTableName)
            .insert({
                name: name,
                namespace: namespace,
                [DEFAULT_VARIABLES_OBJECT_KEY_COL]: valSha1,
            })
            .select(DEFAULT_VARIABLES_OBJECT_KEY_COL)
            .maybeSingle();
        if (error) {
            if (error.code === "23505") {
                console.debug(
                    `Val with sha1 ${valSha1} already in database but could not be fetched.`
                );
                return false;
            }
            throw error;
        }
        if (row) {
            return true;
        }
        return false;
    }

    async updateVar(
        name: string,
        namespace: string | null,
        oldSha1: string,
        newSha1: string
    ): Promise<boolean> {
        let queryBuilder = this.supabaseClient
            .from(this.varsTableName)
            .update({ [DEFAULT_VARIABLES_OBJECT_KEY_COL]: newSha1 })
            .eq("name", name)
            .eq(DEFAULT_VARIABLES_OBJECT_KEY_COL, oldSha1);
        // use "is" to test against null and "eq" for non-null.
        queryBuilder =
            namespace === null
                ? queryBuilder.is("namespace", namespace)
                : queryBuilder.eq("namespace", namespace);
        const { data: row, error } = await queryBuilder.select().maybeSingle();
        if (error) {
            throw error;
        }
        if (row) {
            return true;
        }
        console.debug(
            "no row with name=" +
                name +
                " namespace=" +
                namespace +
                " and val_sha1=" +
                oldSha1 +
                " found in supabase table " +
                this.varsTableName +
                "."
        );
        return false;
    }

    async deleteVar(name: string, namespace: string | null): Promise<boolean> {
        let queryBuilder = this.supabaseClient
            .from(this.varsTableName)
            .delete()
            .eq("name", name);
        // use "is" to test against null and "eq" for non-null.
        queryBuilder =
            namespace === null
                ? queryBuilder.is("namespace", namespace)
                : queryBuilder.eq("namespace", namespace);
        const { data: row, error } = await queryBuilder.select().maybeSingle();
        if (error) {
            throw error;
        }
        if (row) {
            return true;
        }
        console.debug(
            "In DeleteVar: no row with name=" +
                name +
                " namespace=" +
                namespace +
                " found in supabase table " +
                this.varsTableName +
                "."
        );
        return false;
    }
}

//const DEFAULT_VALUE_STORE = new ValStore(new InMemoryJsonStore());
//const DEFAULT_VALUE_STORE = new ValStore(new SupabaseJsonStore(supabase));
const DEFAULT_VALUE_STORE_LIST: Array<JsonStore> = [];
DEFAULT_VALUE_STORE_LIST.push(new InMemoryJsonStore());
if (typeof window !== "undefined") {
    DEFAULT_VALUE_STORE_LIST.push(new BrowserIndexedDBJsonStore());
} else {
    //DEFAULT_VALUE_STORE_LIST.push(new FileBackedJsonStore());
}
export let DEFAULT_VALUE_STORE = new ValStore(
    new MultiJsonStore(DEFAULT_VALUE_STORE_LIST)
);

export class Val {
    readonly __jsosValStore: ValStore;
    readonly __jsosSha1: string;
    readonly __jsosValObject: any;

    constructor(object: any, sha1: string, valStore: ValStore) {
        // TODO: make a deep copy of `object` so ensure it can't be mutated outside of this class
        this.__jsosValObject = object;
        this.__jsosValStore = valStore;
        this.__jsosSha1 = sha1;
        return new Proxy(this, {
            get: (target, prop, receiver) => {
                if (Reflect.has(target, prop)) {
                    return Reflect.get(target, prop, receiver);
                } else {
                    const jsosObject = target.__jsosValObject;
                    if (jsosObject === null) {
                        // Since Vals can wrap null, we have to gracefully
                        // handle the case of attemted property accesses on
                        // null.
                        return null;
                    }
                    if (jsosObject !== Object(jsosObject)) {
                        // If target.__jsosObject is a primitive, then it
                        // doesn't have a prop so Reflect.get breaks since it
                        // bypasses Javascript's automatic type boxing behavior
                        // (e.g., treating a string primitive as a String).
                        // Using this instead of Reflect.get() will
                        // automatically box the primitive.
                        return jsosObject[prop];
                    }
                    return Reflect.get(jsosObject, prop, receiver);
                }
            },
        });
    }

    // Return a new Val by making a copy of this Val and then applying
    // thep provided update function to the copy. Inside the update function
    // the copy can be mutated as desired and returned to create the new Val.
    // However, in the Val that get's created and returned, the underlying
    // object is immutable (i.e. deeply frozen).
    async __jsosUpdate(
        updateFn: AsyncValUpdateFn | SyncValUpdateFn
    ): Promise<Val> {
        let newValObj = updateFn(await this.__jsosObjectCopy(false));
        if (newValObj instanceof Promise) {
            newValObj = await newValObj;
        }
        return await NewVal({
            object: newValObj,
            valStore: this.__jsosValStore,
        });
    }

    async __jsosUpdateIn(
        indexArray: Array<string | number>,
        updateFn: (oldObject: any) => any
    ): Promise<Val> {
        throw Error("Not implemented");
    }

    __jsosSetIn(indexArray: Array<string | number>, newVal: any): Promise<Val> {
        throw Error("Not implemented");
    }

    // Return a copy of this Val's underlying object.
    // If `freeze` is true, the copy will be deeply frozen.
    async __jsosObjectCopy(freeze: boolean = true): Promise<any> {
        return await this.__jsosValStore.getVal(this.__jsosSha1, freeze);
    }

    __jsosEquals(other: Val): boolean {
        return this.__jsosSha1 === other.__jsosSha1;
    }

    __jsosIsVal(): true {
        return true;
    }
}

type ValWrapper<T> = T extends null ? Val : T & Val;
//type VarWrapper<T> = T extends null ? Var : T & Var;
type VarWrapper<T> = T extends null
    ? Var
    : (T extends infer U & Val ? U : T) & Var;

export async function NewVal<T>(options: {
    object: T;
    valStore?: ValStore;
}): Promise<ValWrapper<T>> {
    const { object, valStore = DEFAULT_VALUE_STORE } = options;
    const [sha1, __] = await valStore.putVal(object);
    const putVal = await valStore.getVal(sha1);
    return new Val(putVal, sha1, valStore) as ValWrapper<T>;
}

export async function ValFromSha1(options: {
    sha1: string;
    valStore?: ValStore;
}): Promise<Val> {
    const { sha1, valStore = DEFAULT_VALUE_STORE } = options;
    const obj = await valStore.getVal(sha1);
    return new Val(obj, sha1, valStore);
}

//export const DEFAULT_VARIABLE_STORE = new InMemoryVarStore();
//export const DEFAULT_VARIABLE_STORE = new SupabaseVarStore(supabase);
//export const DEFAULT_VARIABLE_STORE = new FileBackedVarStore();
export let DEFAULT_VARIABLE_STORE: VarStore;
if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
    DEFAULT_VARIABLE_STORE = new BrowserLocalStorageVarStore();
} else {
    //DEFAULT_VARIABLE_STORE = new FileBackedVarStore();
}

// A shared mutable object.
//
// Wraps any mutable object, auto-captures mutations to that object by
// creating a new underlying `Val` from the post-mutated object and
// setting __jsosVal to it.
//
// Use cases:
// 1) shared
//   a) remote changes are asyncrously pushed automatically to this Var
//      causing the underlying Val to be replaced with a new one.
//   b) manual/explicit syncing done via __jsosPull();
// c) const - essentially a snapshot of a named Val at a point in time. Can't
//    be updated. Once a Var object is set to const, it can't be reverted to
//    a mutable object. You can however, create a new Var object from the
//    same (name, namespace, valSha1) tuple that is not a const.
//
// A Var is intrinsically shared (via optimistic concurrency control)
// but you do have control over:
// 1) who it is shared with (e.g., you can share only with yourself
//    by using only an in-memory VarStore)
// 2) how conflicts are handled (e.g, pull updates and retry)
//
// When a var update fails due to a conflict, an error is thrown. You
// can catch it, pull updates, and try again.
//
// If __jsosSubscribeToUpdates is false, then the val is not auto-updated when
// changes are pushed to __jsosVarStore for the (__jsosName,
// __jsosNamespace) key. If it is true, then __jsosVal is
// updated automatically when changes are pushed to __jsosVarStore
// for the (__jsosName, __jsosNamespace) key.
//
// The level of sharing is determined by who else has access to
// __jsosVarStore. If that is not a shared database, e.g.: if it
// is an InMemoryStore, then you are only sharing with yourself which should
// povide sufficient control.
//
// TODO MAYBE: support different levels of sharing at the VarStore level.
// CRUD operations could be separated out, e.g.: allow sharing read-only access.
//
// We use Optimistic Concurrency Control, so updates to a var will
// thow an error if the var has been changed in
// __jsosVarStore since this var last pulled updates from it
// either via subscribing to updates or via calling __jsosPull().
export class Var {
    /*
       A Var has a name, optionally a namespace, and the address (i.e., sha1) of a Val.
        A var can be updated to refer to a different Val. This is done via an atomic
        update to the backing database.
        By default a Var is subscribed to Supabase postgres updates to the var.
    */
    __jsosVarStore: VarStore;
    __jsosName: string;
    __jsosNamespace: string | null;
    __jsosVal: Val;
    // __jsosVarObj is a local in-memory object that can be synchronously updated by the user via proxy methods on this Var.
    // Updates to it are pushed async to the VarStore, and it can be updated in the other direction via either __jsosPull() or
    // by subscribing to updates. If push fails due to optimistic concurrency control, then an error is thrown.
    __jsosVarObj: any;
    __jsosParentVal?: Val;
    __jsosAutoPullUpdates: boolean;
    __jsosSubscriptionIDs: Array<string>;
    // TODO: implement IsConst, ReadOnly, and Pull()
    // If true, this Var behaves like a named Val by making it immutable.
    // To make changes one has to update the Var to make this false.
    // Note that this does *not* make the var immutable in the VarStore,
    // just immutable via this Var object.
    //__jsosIsConst: boolean;
    // while true, causes local mutations to this var to fail, though remote
    // changes can still be pulled in. This is a useful guard against accidental
    // updates.
    //__jsosIsReadOnly: boolean;
    // Fetch Val from VarStore and set __jsosVal to it,
    // overwriting whaterver val is there. This will throw an error if
    // __jsosIsConst is true. Pulling updates is useful when
    // __jsosAutoPullUpdates is false, in which case it gives you
    // control over when to sync this Var to the shared val.
    //__jsosPull(): void;

    constructor(
        name: string,
        namespace: string | null,
        jsosVal: Val,
        object: any,
        varStore: VarStore,
        autoPullUpdates: boolean,
        callback: VarUpdateCallback | null = null,
        parentVal?: Val
    ) {
        this.__jsosVarStore = varStore;
        this.__jsosName = name;
        this.__jsosNamespace = namespace;
        this.__jsosVal = jsosVal;
        this.__jsosVarObj = object;
        this.__jsosAutoPullUpdates = autoPullUpdates;
        this.__jsosSubscriptionIDs = [];
        this.__jsosParentVal = parentVal;
        if (autoPullUpdates) {
            const newSub = this.__jsosVarStore.subscribeToUpdates(
                name,
                namespace,
                async (
                    name: string,
                    namespace: string | null,
                    oldSha1: string | null,
                    newSha1: string
                ): Promise<void> => {
                    if (
                        name === this.__jsosName &&
                        namespace === this.__jsosNamespace
                    ) {
                        this.__jsosVal = await ValFromSha1({
                            sha1: newSha1,
                            valStore: this.__jsosVal.__jsosValStore,
                        });
                        this.__jsosVarObj =
                            await this.__jsosVal.__jsosObjectCopy(false);
                        //console.debug(
                        //    `Var (name=${this.__jsosName}, namespace=${this.__jsosNamespace} ` +
                        //        `updated via subscription: oldSha1=${oldSha1}, newSha1=${newSha1}`
                        //);
                        //if (oldSha1 !== this.__jsosVal.__jsosSha1) {
                        //    console.debug(
                        //        "NOTE: skipping lineage during update from subscription: " +
                        //            "oldSha1 !== Var's current __jsosSha1"
                        //    );
                        //}
                    }
                }
            );
            this.__jsosSubscriptionIDs.concat(newSub);
            if (callback) {
                this.__jsosSubscriptionIDs.concat(
                    this.__jsosVarStore.subscribeToUpdates(
                        name,
                        namespace,
                        callback
                    )
                );
            }
        }

        return new Proxy(this, {
            get: (target, prop, receiver) => {
                if (Reflect.has(target, prop)) {
                    return Reflect.get(target, prop, receiver);
                } else if (
                    target.__jsosVarObj &&
                    Reflect.has(target.__jsosVarObj, prop)
                ) {
                    return Reflect.get(target.__jsosVarObj, prop, receiver);
                }
            },
            set: (target, prop, val, receiver) => {
                if (Reflect.has(target, prop)) {
                    return Reflect.set(target, prop, val, receiver);
                } else {
                    const setRes = Reflect.set(
                        target.__jsosVarObj,
                        prop,
                        val,
                        target.__jsosVarObj
                    );
                    (async () => {
                        // __jsosUpdate() sets __jsosVarObj to a new copy of the new Val's object
                        // which is redundant in this case since we set it above already
                        await target.__jsosUpdate((_) => target.__jsosVarObj);
                        console.log(
                            "asynchronously updated __jsosVal to ",
                            receiver.__jsosVal
                        );
                    })();
                    return setRes;
                }
            },
        });
    }

    get __jsosSha1(): string {
        return this.__jsosVal.__jsosSha1;
    }

    async __jsosSet(newVal: any): Promise<boolean> {
        return await this.__jsosUpdate((_) => newVal);
    }

    async __jsosSetIn(
        indexArray: Array<string | number>,
        newVal: any
    ): Promise<void> {
        throw Error("Not implemented");
    }

    // Returns false if update failed, true if it succeeded or was a no-op.
    async __jsosUpdate(
        updateFn: AsyncValUpdateFn | SyncValUpdateFn
    ): Promise<boolean> {
        const oldVal = this.__jsosVal;
        const newVal = await oldVal.__jsosUpdate(updateFn);
        if (oldVal.__jsosSha1 !== newVal.__jsosSha1) {
            const updateVarRes = await this.__jsosVarStore.updateVar(
                this.__jsosName,
                this.__jsosNamespace,
                oldVal.__jsosSha1,
                newVal.__jsosSha1
            );
            if (updateVarRes) {
                this.__jsosVal = newVal;
            } else {
                console.debug(
                    `Failed to update var name=${this.__jsosName} namespace=${this.__jsosNamespace} in VarStore.`
                );
                return false;
            }
        }
        this.__jsosVarObj = await this.__jsosVal.__jsosObjectCopy(false);
        return true;
    }

    async __jsosUpdateIn(
        indexArray: Array<string | number>,
        updateFn: (oldObject: any) => any
    ): Promise<void> {
        throw Error("Not implemented");
    }

    __jsosEquals(other: Var) {
        return (
            this.__jsosName === other.__jsosName &&
            this.__jsosNamespace === other.__jsosNamespace &&
            this.__jsosVal.__jsosEquals(other.__jsosVal)
        );
    }

    __jsosIsVar(): true {
        return true;
    }
}

// Create a new Var object.  If val is a `Val` object, then this
// just directly uses its sha1.  Else this calls `Val.create(val)`
// which creates a new Val in the ValStore and then uses its sha1 for
// the Var.  Throws error if the Var already exists in the VarStore.
// If updateCallback is provided, it will be called any time the Var
// is updated externally.
export async function NewVar<T>(options: {
    name: string;
    namespace?: string;
    val: T;
    valStore?: ValStore;
    varStore?: VarStore;
    autoPullUpdates?: boolean;
    callback?: VarUpdateCallback;
}): Promise<VarWrapper<T>> {
    const {
        name,
        namespace = null,
        val,
        valStore = DEFAULT_VALUE_STORE,
        varStore = DEFAULT_VARIABLE_STORE,
        autoPullUpdates = true,
        callback,
    } = options;
    let forSureAVal: Val;
    if (val instanceof Val) {
        forSureAVal = val;
    } else {
        forSureAVal = await NewVal({ object: val, valStore });
    }
    let obj: any = await forSureAVal.__jsosObjectCopy(false);
    const newVarRes = await varStore.newVar(
        name,
        namespace,
        forSureAVal.__jsosSha1
    );
    if (!newVarRes) {
        if (await varStore.getVar(name, namespace)) {
            throw Error(`Var ${name} already exists in VarStore`);
        }
        throw Error("Failed to create new var in VarStore");
    }
    return new Var(
        name,
        namespace,
        forSureAVal,
        obj,
        varStore,
        autoPullUpdates,
        callback
    ) as VarWrapper<T>;
}

// returns undefined if the Var does not exist in the VarStore.
export async function GetVar(options: {
    name: string;
    namespace?: string;
    valStore?: ValStore;
    varStore?: VarStore;
    autoPullUpdates?: boolean;
    callback?: VarUpdateCallback;
}): Promise<any> {
    const {
        name,
        namespace = null,
        valStore = DEFAULT_VALUE_STORE,
        varStore = DEFAULT_VARIABLE_STORE,
        autoPullUpdates = true,
        callback,
    } = options;
    const valSha1 = await varStore.getVar(name, namespace);
    if (valSha1 === undefined) {
        return undefined;
    }
    const val = await ValFromSha1({ sha1: valSha1, valStore });
    const mutableObjCopy = await val.__jsosObjectCopy(false);
    return new Var(
        name,
        namespace,
        val,
        mutableObjCopy,
        varStore,
        autoPullUpdates
    ) as any;
}

export async function GetOrNewVar(options: {
    name: string;
    namespace?: string;
    defaultVal: any;
    valStore?: ValStore;
    varStore?: VarStore;
    autoPullUpdates?: boolean;
    callback?: VarUpdateCallback;
}) {
    const {
        name,
        namespace,
        defaultVal,
        valStore = DEFAULT_VALUE_STORE,
        varStore = DEFAULT_VARIABLE_STORE,
        autoPullUpdates = true,
        callback,
    } = options;
    const gotVaR = await GetVar({
        name,
        namespace,
        valStore,
        varStore,
        autoPullUpdates,
        callback,
    });
    if (gotVaR !== undefined) {
        return gotVaR;
    }
    return await NewVar({
        name,
        namespace,
        val: defaultVal,
        valStore,
        varStore,
        autoPullUpdates,
        callback,
    });
}

export async function DeleteVar(options: {
    name: string;
    namespace?: string;
    varStore?: VarStore;
}): Promise<boolean> {
    const {
        name,
        namespace = null,
        varStore = DEFAULT_VARIABLE_STORE,
    } = options;
    return await varStore.deleteVar(name, namespace);
}
