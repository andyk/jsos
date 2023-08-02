import { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import {
    Collection,
    isCollection,
    List,
    Map as ImmutableMap,
    Set,
    OrderedMap,
    OrderedSet,
    Stack,
    Record,
    fromJS,
    FromJS,
} from "immutable";
import hash from "object-hash";
import supabase from "./supabase";
import _ from "lodash";
//import fs from "fs";

/*
=============================================================
=================== JSOS - Key Abstractions =================
=============================================================

== JObject ==
The type of objects that this library handles: including aribrarily nested 
arrangements of any Json types or Immutable.Collections

== getSha1() ==
returns the hash of an object, which is used as address in our object
store

== putObject / getObject ==
Low-level functions that store and retrieve JObject's from the database (and
local cache). Immutable.Collections include List, Map, Set, OrderedMap,
OrderedSet, Stack, and Record.

== PersistentObject ==
Immutable abstration with persistence. Wraps JObjects (i.e., primitives +
Immutables.Collections)
For v0: we use toJS() and fromJS() to convert between Immutable and JS objects
        which throws means any Map and Array types are converted to Immutable.Map
        and Immutable.List types respectively and the original mix of plain JS
        List and Map types are lost.

== Variable ==
A shared mutable named reference to a PersistentObject. This is essentially a
(name: string, namespace: string, sha1: string) tuple and some helper functions
for updating & syncing that tuple with the database. As the Variable is updated,
the reference is updated in the database.

*/

/*
async function loadCache(cacheName: string) {
    // Browser
    if (typeof window !== 'undefined') {
      return new Promise((resolve, reject) => {
        const openDBRequest = indexedDB.open(cacheName);
  
        openDBRequest.onerror = function(event) {
          console.error("Error opening IndexedDB:", event);
          reject((event.target as IDBOpenDBRequest).error);
        };
  
        openDBRequest.onsuccess = function(event) {
          const db = (event.target as IDBOpenDBRequest).result;
          const transaction = db.transaction(cacheName);
          const objectStore = transaction.objectStore(cacheName);
          const getRequest = objectStore.get(cacheName);
  
          getRequest.onerror = function(event) {
            console.error("Error getting data from IndexedDB:", event);
            reject((event.target as IDBRequest).error);
          };
  
          getRequest.onsuccess = function(event) {
            resolve((event.target as IDBRequest).result || {});
          };
        };
      });
    } else {
      // Node.js
      const fs = require('fs');
      if (fs.existsSync(cacheName)) {
        const cacheData = fs.readFileSync(cacheName, "utf8");
        return JSON.parse(cacheData);
      } else {
        return {};
      }
    }
  }
 */

// TODO: figure out if using unknown here is really dumb.
type Json = string | number | boolean | null | { [key: string]: Json } | Json[];
type JObject = Json | Collection<any, any> | undefined;

// Re-using seriealization special keys from
// https://github.com/glenjamin/transit-immutable-js
const MAP_KEY = "~#iM";
const LIST_KEY = "~#iL";
const SET_KEY = "~#iS";
const ORDERED_MAP_KEY = "~#iOM";
const ORDERED_SET_KEY = "~#iOS";
const STACK_KEY = "~#iStk";
const RECORD_KEY = "~#iR";
const DENORMALIZED_OBJECT_KEY = "~#N"; // This one is our own invention.
// TODO: add Map (iM), Set (iS), OrderedSet (iO), Stack (iStk), ??? and Null (_) ???

type SerializationKeys =
    | typeof MAP_KEY
    | typeof LIST_KEY
    | typeof SET_KEY
    | typeof ORDERED_MAP_KEY
    | typeof ORDERED_SET_KEY
    | typeof STACK_KEY
    | typeof RECORD_KEY;
type toObjectReturn<K, V> = ReturnType<Collection<K, V>["toObject"]>;
type toArrayReturn<K, V> = ReturnType<Collection.Keyed<K, V>["toArray"]>;

type SerializedCollection<K, V> = (
    | SerializationKeys
    | toObjectReturn<K, V>
    | toArrayReturn<K, V>
)[];

function isPlainObject(obj: any): obj is { [key: string]: any } {
    return (
        typeof obj === "object" &&
        obj !== null &&
        !Array.isArray(obj) &&
        Object.prototype.toString.call(obj) === "[object Object]"
    );
}

function isPersistentObject(obj: any): obj is PersistentObject {
    return obj?.isPersistentObject?.();
}

const OBJ_CACHE_FILE_PATH = "./objectCache.json";
//let objectCache = await loadCache(OBJ_CACHE_FILE_PATH);
let objectCache: { [key: string]: Json } = {};

export function getSha1(o: any): string {
    if (o && typeof o.sha1 === "string") {
        return o.sha1;
    }
    return hash(o, { algorithm: "sha1", encoding: "hex" });
}

export function cacheObject(
    object: Json
): [Json, string] {
    const sha1 = getSha1(object);
    objectCache[sha1] = object;
    //fs.writeFileSync(OBJ_CACHE_FILE_PATH, JSON.stringify(objectCache));
    return [object, sha1];
}

const REF_CACHE_FILE_PATH = "./referenceCache.json";
//let referenceCache = loadCache(REF_CACHE_FILE_PATH);
let referenceCache: { [key: string]: any } = {};

export function cacheReference(
    name: string,
    namespace: string,
    sha1: string
): boolean {
    referenceCache[name + "-" + namespace] = sha1;
    //fs.writeFileSync(REF_CACHE_FILE_PATH, JSON.stringify(referenceCache));
    return true;
}

export function getCachedReference(
    name: string,
    namespace: string
): string | undefined {
    return referenceCache[name + "-" + namespace];
}

export function encodeImmutable<K, V>(
    object: Collection<K, V>
): any {
    /* Shallow encoding of an Immutable-js object.  This needs to be called by a
     * recursive function to encode nested Immutable objects. */
    if (OrderedMap.isOrderedMap(object)) {
        // NOTE: the OrderedMap data structure is special because we have to
        // serialize it as an Array<Array> if we want to guarantee that the
        // order of the keys is preserved because calling toObject() in it
        // returns a JS object which does not preserve key order for integer
        // keys.
        return [ORDERED_MAP_KEY, (object as OrderedMap<K, V>).toArray()];
    }
    if (ImmutableMap.isMap(object)) {
        return [MAP_KEY, (object as ImmutableMap<K, V>).toObject()];
    }
    if (List.isList(object)) {
        return [LIST_KEY, object.toObject()];
    }
    if (Set.isSet(object)) {
        return [SET_KEY, object.toObject()];
    }
    if (OrderedSet.isOrderedSet(object)) {
        // Need a type cast here because of a bug in Immutable.js:
        // https://github.com/immutable-js/immutable-js/issues/1947
        return [ORDERED_SET_KEY, (object as Collection<K, V>).toObject()];
    }
    if (Stack.isStack(object)) {
        return [STACK_KEY, object.toObject()];
    }
    if (Record.isRecord(object)) {
        throw "Immutable.Record serialization not yet supported.";
        //return [RECORD_KEY, object.toObject()];
    }
    throw Error("Unsupported Immutable type: " + object);
}

export function decodeImmutable<T>(object: T): T | Collection<any, any> {
    if (Array.isArray(object)) {
        if (object?.[0] === ORDERED_MAP_KEY) {
            return OrderedMap(object[1] as Array<any>);
        }
        if (object?.[0] === MAP_KEY) {
            return ImmutableMap(object[1]);
        }
        if (object?.[0] === LIST_KEY) {
            return List(object[1]);
        }
        if (object?.[0] === SET_KEY) {
            return Set(object[1]);
        }
        if (object?.[0] === ORDERED_SET_KEY) {
            return OrderedSet(object[1]);
        }
        if (object?.[0] === STACK_KEY) {
            return Stack(object[1]);
        }
        if (object?.[0] === RECORD_KEY) {
            throw "Immutable.Record deserialization not yet supported.";
            //return Record(object[1]);
        }
    }
    return object;
}

export class JsosClient {
    supabaseClient: SupabaseClient;
    objectsTableName: string;
    referencesTableName: string;

    constructor(
        supabaseClient: SupabaseClient,
        objectsTableName: string = "jsos_objects",
        referencesTableName: string = "jsos_refs"
    ) {
        this.supabaseClient = supabaseClient;
        this.objectsTableName = objectsTableName;
        this.referencesTableName = referencesTableName;
    }

    async writeObjectToDatabase(object: Json): Promise<[Json, string]> {
        const sha1 = getSha1(object);
        if (sha1 in objectCache) {
            return [objectCache[sha1], sha1];
        }
        const { data: row, error } = await this.supabaseClient
            .from(this.objectsTableName)
            .insert({ sha1: sha1, json: object })
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
                    .eq("sha1", sha1)
                    .maybeSingle();
                if (error) {
                    throw error;
                }
                if (row) {
                    return cacheObject(row.json);
                }
                throw new Error(
                    `Object with sha1 ${sha1} already in database but could not be fetched.`
                );
            }
            throw error;
        }
        if (row) {
            return cacheObject(row.json);
        }
        throw new Error(
            `Object ${sha1} was inserted but not successfully returned.`
        );
    }

    async getObject(
        sha1: string,
        denormalize = true,
        useCache: boolean = true
    ): Promise<JObject> {
        let json;
        const cachedDenormalizedRef = getCachedReference(
            sha1,
            DENORMALIZED_OBJECT_KEY
        );
        let foundDenormalizedRef = false;
        // First see if denormalized object is cached.
        if (useCache && denormalize && cachedDenormalizedRef) {
            json = this.getObject(cachedDenormalizedRef, false, useCache);
            foundDenormalizedRef = true;
            // Else, see if the normalized object is cached.
        } else if (useCache && sha1 in objectCache) {
            json = objectCache[sha1];
        } else {
            const { data: row, error } = await this.supabaseClient
                .from(this.objectsTableName)
                .select("json")
                .eq("sha1", sha1)
                .maybeSingle();
            if (error) {
                throw error;
            }
            if (row) {
                json = row.json;
            } else {
                throw new Error(
                    `Object with sha1 '${sha1}' not found in database`
                );
            }
        }
        if (denormalize && !foundDenormalizedRef) {
            json = this.denormalizeObject(json);
        }
        return decodeImmutable(json);
    }

    denormalizeObject = async (json: Json): Promise<JObject> => {
        let denormalizedJson: Json;
        // In case of non-primative, use a copy of the json object so we don't mutate the object passed in.
        if (json && typeof json === "object") {
            if (Array.isArray(json)) {
                denormalizedJson = [...json];
            } else {
                denormalizedJson = { ...json };
            }
        } else {
            denormalizedJson = json;
        }
        if (
            json &&
            typeof json === "object" &&
            denormalizedJson &&
            typeof denormalizedJson === "object"
        ) {
            for (let k in json) {
                if (
                    (json as any)[k] &&
                    typeof (json as any)[k] === "string" &&
                    (json as any)[k].startsWith("ref:")
                ) {
                    denormalizedJson[k] = await this.getObject(
                        json[k].slice(4)
                    );
                } else {
                    denormalizedJson[k] = json[k];
                }
            }
        }
        return denormalizedJson;
    };

    async getImmutableObject(sha1: string): Promise<FromJS<JObject>> {
        return fromJS(await this.getObject(sha1));
    }

    /* TODO: normalize via local recursion first, then push all objects with one
     * call to supabase.
     *
     * TODO: break the logic from this out into putPlainObject() and putNormalizedObject().
     *
     * TODO: handle any object by dropping properties that aren't of type Json.
     */
    async putObject(object: JObject, normalize: boolean = true): Promise<Json> {
        /* 
        Serialize Immutable.Collections specially by wrapping them in
        [<SPECIAL_TOKEN_STR>, <JSON_SERIALIZED_COLLECTION>].

        Returns the object that was written to (or already existed in) the database.
        */
        let normalizedJson;
        if (normalize && object && typeof object === "object") {
            if (isCollection(object)) {
                normalizedJson = encodeImmutable(object);
            } else if (isPlainObject(object)) {
                normalizedJson = { ...object };
            } else if (Array.isArray(object)) {
                normalizedJson = [...object];
            } else {
                throw Error(
                    "unsupported object type, only plain objects, " +
                        "arrays, and Immutable.Collections are supported."
                );
            }
            for (let k in normalizedJson) {
                normalizedJson[k] = `ref:${getSha1(
                    await this.putObject(normalizedJson[k])
                )}`;
            }
        } else {
            normalizedJson = object;
        }

        // Write normalized Object
        const [writtenNormalized, sha1] = await this.writeObjectToDatabase(
            normalizedJson
        );

        // Locally cache denormalized Object
        //let denormalizedSha1 = cacheObject(object)[1];
        //if (denormalizedSha1 !== sha1) {
        //    cacheReference(sha1, DENORMALIZED_OBJECT_KEY, denormalizedSha1);
        //}
        return writtenNormalized;
    }

    getReference = async (
        name: string,
        namespace: string | null = null
    ): Promise<string | undefined> => {
        let queryBuilder = this.supabaseClient
            .from(this.referencesTableName)
            .select("object")
            .eq("name", name);
        // Use "is" for NULL and "eq" for non-null
        queryBuilder =
            namespace === null
                ? queryBuilder.is("namespace", namespace)
                : queryBuilder.eq("namespace", namespace);
        let { data: row, error } = await queryBuilder.maybeSingle();
        if (error) {
            throw error;
        }
        if (row) {
            return row.object;
        }
    };

    putReference = async (
        name: string,
        namespace: string | null,
        sha1: string,
        useCache: boolean = true
    ): Promise<boolean> => {
        const { data: row, error } = await this.supabaseClient
            .from(this.referencesTableName)
            .insert({ name: name, namespace: namespace, object: sha1 })
            .select("object")
            .maybeSingle();
        if (error) {
            throw error;
        }
        if (row) {
            return true;
        }
        if (useCache) {
            cacheReference(name, namespace, sha1);
        }
    };

    persistentObject = async (object: JObject): Promise<PersistentObject> => {
        return PersistentObject.create(this, object);
    };

    getPersistentObject = async (
        sha1: string
    ): Promise<PersistentObject | undefined> => {
        const gotObj = await this.getObject(sha1);
        return PersistentObject.create(this, gotObj);
    };

    persistentOrderedMap = async <K, V>(
        ...args
    ): Promise<PersistentOrderedMap<K, V>> => {
        return PersistentOrderedMap.create<K, V>(this, ...args);
    };

    getPersistentOrderedMap = async <K, V>(
        sha1: string
    ): Promise<PersistentOrderedMap<K, V> | undefined> => {
        const orderedMap = await this.getObject(sha1);
        if (orderedMap != null) {
            return PersistentOrderedMap.create<K, V>(this, orderedMap);
        }
    };

    persistentCollection = async <K, V>(
        collection: Collection<K, V>
    ): Promise<PersistentCollection<K, V>> => {
        return PersistentCollection.create<K, V>(this, collection);
    };

    /*getPersistentCollection = async <K, V>(
        sha1: string
    ): Promise<PersistentCollection<K, V> | undefined> => {
        const jObject = await this.getObject(sha1);
        if (
            typeof jObject === "object" &&
            jObject !== null &&
            isCollection(jObject)
        ) {
            const collection = jObject;
            return PersistentCollection.create<K, V>(this, collection);
        }
    };
    */

    variable = async (
        name: string,
        namespace: string | null = null,
        subscribeToSupabase: boolean = true,
        callbackOnChange?: (newObject: any, newSha1: string) => void
    ): Promise<Variable> => {
        return await Variable.create(
            this,
            name,
            namespace,
            subscribeToSupabase,
            callbackOnChange
        );
    };
}

export class Variable {
    /*
        A Variable has a name, optionally a namespace, and the address (i.e., sha1) of a PersistentObject.
        A variable can be updated to refer to a different PersistentObject. This is done via an atomic
        update to the backing database.
        By default a Variable is subscribed to Supabase postgres updates to the variable.
    */
    jsosClient: JsosClient;
    name: string;
    namespace: string | null;
    objectSha1: string;
    callbackOnChange: (newObject: any, newSha1: string) => void;
    #supabaseSubcription: RealtimeChannel | null;

    constructor(
        jsosClient: JsosClient,
        name: string,
        objectSha1: string,
        namespace: string | null = null,
        callbackOnChange?: (newObject: any, newSha1: string) => void
    ) {
        this.jsosClient = jsosClient;
        this.name = name;
        this.namespace = namespace;
        this.objectSha1 = objectSha1;
        this.callbackOnChange = callbackOnChange;
        this.#supabaseSubcription = null;
    }

    get supabaseSubscription(): RealtimeChannel | null {
        return this.#supabaseSubcription;
    }

    subscribed(): boolean {
        return (
            this.#supabaseSubcription !== null &&
            this.#supabaseSubcription !== undefined
        );
    }

    subscribeToSupabase = async (force: boolean = false) => {
        //Subscribe to updates from supabase.
        if (this.subscribed()) {
            return;
        }
        const remoteSha1 = await this.jsosClient.getReference(
            this.name,
            this.namespace
        );
        if (this.objectSha1 !== remoteSha1) {
            console.debug(
                "remote sha1 for var name " +
                    this.name +
                    " is " +
                    remoteSha1 +
                    " but local sha1 is " +
                    this.objectSha1
            );
            if (force) {
                console.debug(
                    "force=true, so updating local sha1 to match remote sha1."
                );
                this.objectSha1 = remoteSha1;
            } else {
                console.error(
                    "force=false, and out of sync w/ remote, so not subscribing " +
                        "to supabase updates. You may want to re-run subscribeToSupabase() " +
                        "with force=true to update the local sha1 to match the remote sha1."
                );
            }
        }
        this.#supabaseSubcription = await this.jsosClient.supabaseClient
            .channel("any")
            .on(
                "postgres_changes",
                {
                    event: "*",
                    schema: "public",
                    table: this.jsosClient.referencesTableName,
                    filter: `name=eq.${this.name}`,
                },
                (payload) => {
                    if (payload.new["namespace"] === this.namespace) {
                        this.objectSha1 = payload.new["object"];
                    }
                    if (this.callbackOnChange) {
                        this.callbackOnChange(this, payload.new["object"]);
                    }
                }
            )
            .subscribe();
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
    };

    static create = async (
        jsosClient: JsosClient,
        name: string,
        namespace: string | null = null,
        subscribeToSupabase: boolean = true,
        callbackOnChange?: (newVar: Variable, newObj: any) => void
    ): Promise<Variable> => {
        /* If this variable exists already, fetch & return it. Else create it and
         * initialize it to wrap PersistentObject(null) */
        const sha1 = await jsosClient.getReference(name, namespace);
        let newVar;
        if (sha1) {
            newVar = new Variable(
                jsosClient,
                name,
                sha1,
                namespace,
                callbackOnChange
            );
        } else {
            const nullSha1 = await getSha1(await jsosClient.putObject(null));
            await jsosClient.putReference(name, namespace, nullSha1);
            newVar = new Variable(
                jsosClient,
                name,
                nullSha1,
                namespace,
                callbackOnChange
            );
        }
        if (subscribeToSupabase) {
            await newVar.subscribeToSupabase();
        }
        return newVar;
    };

    unsubscribeFromSupabase = async (): Promise<void> => {
        if (this.subscribed()) {
            const res = await this.jsosClient.supabaseClient.removeChannel(
                this.#supabaseSubcription
            );
            if (res === "error" || res === "timed out") {
                console.error(
                    "Error unsubscribing from supabase updates: ",
                    res
                );
            }
            this.#supabaseSubcription = null;
        }
    };

    get = async (): Promise<PersistentObject> => {
        const obj = await this.jsosClient.getPersistentObject(this.objectSha1);
        if (!obj) {
            throw Error(
                `Object with sha1 '${this.objectSha1}' not found in database`
            );
        }
        return obj;
    };

    set = async (
        newVal: JObject | PersistentObject
    ): Promise<PersistentObject> => {
        /* TODO: We might need to use a lock to handle race conditions between
         * this function and updates done by the supbase subscription callback. */
        if (!isPersistentObject(newVal)) {
            newVal = await this.jsosClient.persistentObject(newVal);
        }
        let queryBuilder = this.jsosClient.supabaseClient
            .from(this.jsosClient.referencesTableName)
            .update({ object: newVal.sha1 })
            .eq("name", this.name)
            .eq("object", this.objectSha1);
        // use "is" to test against null and "eq" for non-null.
        queryBuilder =
            this.namespace === null
                ? queryBuilder.is("namespace", this.namespace)
                : queryBuilder.eq("namespace", this.namespace);
        const { data: row, error } = await queryBuilder.select().maybeSingle();
        if (error) {
            throw error;
        }
        if (!row) {
            const { data: innerRow, error } =
                await this.jsosClient.supabaseClient
                    .from(this.jsosClient.referencesTableName)
                    .update({ object: newVal.sha1 })
                    .eq("name", this.name)
                    .eq("namespace", this.namespace)
                    .select()
                    .maybeSingle();
            if (error) {
                throw error;
            }
            if (innerRow) {
                throw new Error(
                    `Object with sha1 '${this.objectSha1}' not found in database. ` +
                        "This variable was probably updated by somebody asynchronously " +
                        "and the update did not make it back to this copy of the variable. " +
                        "Is this variable subscribed() to supabase updates? If not you " +
                        "should subscribe() to supabase updates to avoid this error."
                );
            } else {
                throw new Error(
                    `No ref found in supabase with name ${this.name} ` +
                        `and namespace ${this.namespace}. The associated with this variable ` +
                        `may have been deleted from supabase since you created this variable.`
                );
            }
        } else {
            this.objectSha1 = newVal.sha1;
            return newVal;
        }
    };

    update = async (updateFn: (currVal: JObject) => JObject) => {
        /* Updates the entry in supbase for this variable to point to the new value
        using a postgres transaction to ensure that the object we think is current
        is the same as what the database thinks is the current object pointed
        to by this variable. If the object has changed, we throw an error and
        the caller can try again.
        */
        const currVal = await this.get();
        const newVal = await currVal.update(updateFn);
        return await this.set(newVal);
    };
}

export interface PersistentObjectInterface {
    jsosClient: JsosClient;
    object: JObject;

    isPersistentObject(): true;
    update(
        updateFn: (currVal: JObject) => JObject
    ): Promise<PersistentObjectInterface>;
}

export class PersistentObject {
    /*
    A wrapper around primitive and Immutable types (see the FromJS type in the
    immutables lib) that persists its value to the database at creation
    time.  Becuase any mutation-like like operation returns a new object, that
    object is also a PersistentObject, and itself is also automatically
    persisted.  We wrap the Immutable.Collection types since they already
    elegantly implement the immutable data collection pattern
    */
    #jsosClient: JsosClient;
    #wrappedObject: JObject;
    // TODO: define a type to catpure that a normalized wrapped immutable should be flat not recursively nested
    #normalizedWrappedObject: JObject;
    sha1: string;

    private constructor(
        jsosClient: JsosClient,
        wrappedObject: JObject,
        normalizedWrappedObject: JObject,
        sha1: string
    ) {
        this.#jsosClient = jsosClient;
        this.#wrappedObject = wrappedObject;
        this.#normalizedWrappedObject = normalizedWrappedObject;
        this.sha1 = sha1;
    }

    /* Use create pattern since constructor can't be async */
    static create = async (
        jsosClient: JsosClient,
        object: JObject
    ): Promise<PersistentObject> => {
        const wrappedObject = await jsosClient.putObject(object, false);
        const normalizedWrappedObject = await jsosClient.putObject(object);
        const sha1 = getSha1(normalizedWrappedObject);
        return new PersistentObject(
            jsosClient,
            wrappedObject,
            normalizedWrappedObject,
            sha1
        );
    };

    get jsosClient(): JsosClient {
        return this.#jsosClient;
    }

    get object(): JObject {
        return this.#wrappedObject;
    }

    get normalizedObject(): JObject {
        return this.#normalizedWrappedObject;
    }

    isPersistentObject(): true {
        return true;
    }

    async update(
        updateFn: (currVal: JObject) => JObject
    ): Promise<PersistentObject> {
        const newVal = updateFn(this.object);
        return PersistentObject.create(this.jsosClient, newVal);
    }
}

export class PersistentImmutable {
    /*
    A wrapper around primitive and Immutable types (see the FromJS type in the
    immutables lib) that persists its value to the database at creation
    time.  Becuase any mutation-like like operation returns a new object, that
    object is also a PersistentImmutable, and itself is also automatically
    persisted.  We wrap the Immutable.Collection types since they already
    elegantly implement the immutable data collection pattern
    */
    #jsosClient: JsosClient;
    #wrappedImmutable: FromJS<JObject>;
    // TODO: define a type to catpure that a normalized wrapped immutable should be flat not recursively nested
    #normalizedWrappedImmutable: FromJS<JObject>;
    sha1: string;

    private constructor(
        jsosClient: JsosClient,
        wrappedImmutable: FromJS<JObject>,
        normalizedWrappedImmutable: FromJS<JObject>,
        sha1: string
    ) {
        this.#jsosClient = jsosClient;
        // TODO: make a deep copy of `object` so ensure it can't be mutated outside of this class
        this.#wrappedImmutable = wrappedImmutable;
        this.#normalizedWrappedImmutable = normalizedWrappedImmutable;
        this.sha1 = sha1;
    }

    /* Use create pattern since constructor can't be async */
    static create = async (
        jsosClient: JsosClient,
        object: JObject
    ): Promise<PersistentImmutable> => {
        const normalizedObject = await jsosClient.putObject(object);
        const sha1 = getSha1(normalizedObject);
        return new PersistentImmutable(
            jsosClient,
            fromJS(object),
            fromJS(normalizedObject),
            sha1
        );
    };

    get jsosClient(): JsosClient {
        return this.#jsosClient;
    }

    get object(): FromJS<JObject> {
        return this.#wrappedImmutable;
    }

    get normalizedObject(): FromJS<JObject> {
        let v = this.#normalizedWrappedImmutable;
        return v;
    }

    isPersistentImmutable(): true {
        return true;
    }

    async update(
        updateFn: (currVal: JObject) => JObject
    ): Promise<PersistentImmutable> {
        const newVal = updateFn(this.object);
        return PersistentImmutable.create(this.jsosClient, newVal);
    }
}

export interface PersistentOrderedMap<K, V> {
    update(key: K, notSetValue: V, updater: (value: V) => V): this;
    update(key: K, updater: (value: V | undefined) => V | undefined): this;
    update<R>(updater: (value: this) => R): R;
    set(key: K, value: V): this;
    toObject(): { [key: string]: V };
    equals(other: unknown): boolean;
    get<NSV>(key: K, notSetValue: NSV): V | NSV;
    get(key: K): V | undefined;
}

export class PersistentOrderedMap<K, V> implements PersistentOrderedMap<K, V> {
    jsosClient: JsosClient;
    orderedMap: OrderedMap<K, V>;
    sha1: string;
    wrappedFunctions = ["set", "setIn"];

    private constructor(
        jsosClient: JsosClient,
        orderedMap: OrderedMap<K, V>,
        sha1: string
    ) {
        this.jsosClient = jsosClient;
        this.orderedMap = OrderedMap(orderedMap);
        this.sha1 = sha1;

        return new Proxy(this, {
            get: (target, prop, receiver) => {
                if (Reflect.has(target, prop)) {
                    return Reflect.get(target, prop, receiver);
                } else if (target.wrappedFunctions.includes(prop.toString())) {
                    return function (...args) {
                        const method = Reflect.get(
                            target.orderedMap,
                            prop,
                            receiver
                        ).bind(target.orderedMap);
                        const newMap = PersistentOrderedMap.create<K, V>(
                            target.jsosClient,
                            method(...args)
                        );
                        return newMap;
                    };
                } else {
                    return Reflect.get(target.orderedMap, prop, receiver);
                }
            },
        });
    }

    static create = async <K, V>(
        jsosClient: JsosClient,
        ...args
    ): Promise<PersistentOrderedMap<K, V>> => {
        const map = OrderedMap<K, V>(...args);
        const sha1 = getSha1(await jsosClient.putObject(map));
        return new PersistentOrderedMap(jsosClient, map, sha1);
    };
}

export class PersistentCollection<K, V> {
    jsosClient: JsosClient;
    collection: Collection<K, V>;
    sha1: string;
    wrappedFunctions = ["set", "setIn"];

    private constructor(
        jsosClient: JsosClient,
        collection: Collection<K, V>,
        sha1: string
    ) {
        this.jsosClient = jsosClient;
        this.collection = Collection(collection);
        this.sha1 = sha1;

        return new Proxy(this, {
            get: (target, prop, receiver) => {
                if (Reflect.has(target, prop)) {
                    return Reflect.get(target, prop, receiver);
                } else if (target.wrappedFunctions.includes(prop.toString())) {
                    return function (...args) {
                        const method = Reflect.get(
                            target.collection,
                            prop,
                            receiver
                        ).bind(target.collection);
                        const newMap = PersistentCollection.create<K, V>(
                            target.jsosClient,
                            method(...args)
                        );
                        return newMap;
                    };
                } else {
                    return Reflect.get(target.collection, prop, receiver);
                }
            },
        });
    }

    static create = async <K, V>(
        jsosClient: JsosClient,
        collection: Collection<K, V>
    ): Promise<PersistentCollection<K, V>> => {
        const sha1 = getSha1(await jsosClient.putObject(collection));
        return new PersistentCollection(jsosClient, collection, sha1);
    };
}

const jsos = new JsosClient(supabase);
export default jsos;
