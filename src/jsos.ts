import { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { Collection, OrderedMap, List } from "immutable";
import hash from "object-hash";
import supabase from "./supabase";
import _ from "lodash";
import { createStore, set, entries} from 'idb-keyval/dist/index.cjs';

// WARNING: probably want be very careful what we use the referenceCache for
// since references are shared and mutable so cached values of them
// are likely to be come stale & incorrect. We may want to get rid of the
// referenceCache entirely.

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
Immutable abstration with persistence. Wraps a JObject (i.e., primitives and/or
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

type Json = string | number | boolean | null | { [key: string]: Json } | Json[];
type JObject = Json | Collection<any, any> | undefined;


const OBJ_CACHE_FILE_PATH = "./objectCache.json";
const REF_CACHE_FILE_PATH = "./referenceCache.json";
// Re-using seriealization special keys from
// https://github.com/glenjamin/transit-immutable-js
const ORDERED_MAP_KEY = "~#iOM";
const LIST_KEY = "~#iL";
const DENORMALIZED_OBJECT_KEY = "~#jsosdeNormalizedObject"; // This one is our own invention.
const VARIABLE_PARENT_KEY = "~#jsosVarParent"; // This one is our own invention.
// TODO: add Map (iM), Set (iS), OrderedSet (iO), Stack (iStk), ??? and Null (_) ???

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

function isAsyncFn<T>(fn: any): fn is (...args: any[]) => Promise<T> {
    try {
        const result = fn();
        return result instanceof Promise;
    } catch {
        return false;
    }
}

export function getSha1(o: any): string {
    if (o && typeof o.sha1 === "string") {
        return o.sha1;
    }
    return hash(o, { algorithm: "sha1", encoding: "hex" });
}

export class Cache {
    // An in-memory cache backed by IndexedDB (in browser) or local file (in node.js).
    // At creation, load from persistent storage is done lazily.
    static INDEXDB_STORE_NAME: string = "jsosCache";
    private cache: { [key: string]: any } = {};
    private cacheName: string;
    private indexDBStore: ReturnType<typeof createStore> | null;

    constructor(cacheName: string) {
        this.cacheName = cacheName;
        this.indexDBStore = null;
        this.load(cacheName);
    }

    private async load(cacheName: string) {
        if (typeof window !== "undefined") {
            // In browser
            console.log("trying to create indexDBStore", cacheName)
            this.indexDBStore = createStore(cacheName, Cache.INDEXDB_STORE_NAME);
            if (!this.indexDBStore) {
                throw new Error("indexDBStore is null but should not be.");
            }
            const indexDBEntries = await entries(this.indexDBStore);
            this.cache = Object.fromEntries(indexDBEntries);
        } else {
            // In Node.js
            const fs = require("fs");
            if (fs.existsSync(cacheName)) {
                const cacheData = fs.readFileSync(cacheName, "utf8");
                const result = JSON.parse(cacheData);
                Object.assign(this.cache, result);
            }
        }
    }

    has(key: string) {
        return key in this.cache;
    }

    get(key: string) {
        return this.cache[key];
    }

    put(key: string, value: any) {
        /* Write to memory & asynchronously persist to IndexDB or FS. */
        this.cache[key] = value;

        if (typeof window !== "undefined") {
            // In browser
            try {
                set(key, value, this.indexDBStore);
            } catch (e) {
                console.error("Catching Error writing to indexedDB: ", e);
            }
            console.log("wrote to indexedDB: ", key, value);
        } else {
            // In Node.js
            const fs = require("fs");
            fs.writeFile(this.cacheName, JSON.stringify(this.cache), (err) => {
                if (err) {
                    console.error("Error writing to file: ", err);
                }
            });
        }
    }

    async putReference(name: string, namespace: string, targetSha1: string) {
        await this.put(name + "-" + namespace, targetSha1);
    }

    getReference(name: string, namespace: string) {
        return this.get(name + "-" + namespace);
    }
}

export class JsosClient {
    supabaseClient: SupabaseClient;
    objectsTableName: string;
    referencesTableName: string;
    objectCache: Cache;
    referenceCache: Cache;

    constructor(
        supabaseClient: SupabaseClient,
        objectsTableName: string = "jsos_objects",
        referencesTableName: string = "jsos_refs",
    ) {
        this.supabaseClient = supabaseClient;
        this.objectsTableName = objectsTableName;
        this.referencesTableName = referencesTableName;
        this.objectCache = new Cache(OBJ_CACHE_FILE_PATH);
        this.referenceCache = new Cache(REF_CACHE_FILE_PATH);
    }

    async writeObjectToDatabase(object: Json): Promise<[Json, string]> {
        const sha1 = getSha1(object);
        if (this.objectCache.has(sha1)) {
            console.log("cache hit: ", sha1)
            return [this.objectCache.get(sha1), sha1];
        }
        console.log("cache miss: ", sha1);
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
                    this.objectCache.put(sha1, row.json)
                    return [row.json, sha1];
                }
                throw new Error(
                    `Object with sha1 ${sha1} already in database but could not be fetched.`
                );
            }
            throw error;
        }
        if (row) {
            this.objectCache.put(sha1, row.json)
            return [row.json, sha1];
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
        const cachedDenormalizedRef = this.referenceCache.getReference(
            sha1,
            DENORMALIZED_OBJECT_KEY
        );
        let foundDenormalizedRef = false;
        // First see if denormalized object is cached.
        if (useCache && denormalize && cachedDenormalizedRef) {
            json = this.getObject(cachedDenormalizedRef, false, useCache);
            foundDenormalizedRef = true;
            // Else, see if the normalized object is cached.
        } else if (useCache && this.objectCache.has(sha1)) {
            json = this.objectCache.get(sha1);
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
        if (Array.isArray(json)) {
            if (json?.[0] === ORDERED_MAP_KEY) {
                return OrderedMap(json[1] as Array<any>);
            } else if (json?.[0] === LIST_KEY) {
                return List(json[1] as Array<any>);
            }
        }
        return json;
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
                    json[k] &&
                    typeof json[k] === "string" &&
                    json[k].startsWith("ref:")
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

    /* TODO: normalize via local recursion first, then push all objects with one
     * call to supabase.
     *
     * TODO: break the logic from this out into putPlainObject() and putNormalizedObject().
     *
     * TODO: handle any object by dropping properties that aren't of type Json.
     */
    async putObject(object, normalize = true): Promise<Json> {
        /* 
        Returns the object that was written to (or already existed in) the database.
        */
        let normalizedJson;
        if (normalize && object && typeof object === "object") {
            if (OrderedMap.isOrderedMap(object)) {
                normalizedJson = [ORDERED_MAP_KEY, object.toArray()];
            } else if (List.isList(object)) {
                normalizedJson = [LIST_KEY, object.toArray()];
            } else if (isPlainObject(object)) {
                normalizedJson = { ...object };
            } else if (Array.isArray(object)) {
                normalizedJson = [...object];
            } else {
                throw Error(
                    "unsupported object type, only plain objects, " +
                        "arrays, and (some) immutable collections are supported."
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
        let denormalizedSha1 = getSha1(object);
        if (denormalizedSha1 !== sha1) {
            this.objectCache.put(denormalizedSha1, object);
            this.referenceCache.putReference(sha1, DENORMALIZED_OBJECT_KEY, denormalizedSha1);
        }
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
            if (error.code === "23505") {
                // Reference with name this name and namespace already exists in database.
                const { data: row, error } = await this.supabaseClient
                    .from(this.referencesTableName)
                    .select("object")
                    .eq("name", name)
                    .eq("namespace", namespace)
                    .maybeSingle();
                if (error) {
                    throw error;
                }
                if (row && row.object === sha1) {
                    return true;
                }
                throw new Error(
                    `Object with sha1 ${sha1} already in database but could not be fetched.`
                );
            }
        }
        if (row) {
            return true;
        }
        if (useCache) {
            this.referenceCache.put(name + namespace, sha1);
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

    variable = async (
        name: string,
        namespace: string | null = null,
        subscribeToSupabase: boolean = true,
        updateCallback?: (newObject: any, newSha1: string) => void
    ): Promise<Variable> => {
        return await Variable.create(
            this,
            name,
            namespace,
            subscribeToSupabase,
            updateCallback
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
    parentSha1: string | null;
    updateCallback: (newObject: any, newSha1: string) => void;
    #supabaseSubcription: RealtimeChannel | null;

    constructor(
        jsosClient: JsosClient,
        name: string,
        objectSha1: string,
        parentSha1: string | null = null,
        namespace: string | null = null,
        updateCallback?: (newObject: any, newSha1: string) => void
    ) {
        this.jsosClient = jsosClient;
        this.name = name;
        this.namespace = namespace;
        this.objectSha1 = objectSha1;
        this.parentSha1 = parentSha1;
        this.updateCallback = updateCallback;
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
                async (payload) => {
                    if (payload.new["namespace"] === this.namespace) {
                        this.objectSha1 = payload.new["object"];
                    }
                    if (this.updateCallback) {
                        this.updateCallback(
                            await this.get(),
                            payload.new["object"]
                        );
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
        updateCallback?: (newObject: any, newSha1: string) => void
    ): Promise<Variable> => {
        /* If this variable exists already, fetch & return it. Else create it and
         * initialize it to wrap PersistentObject(null) */
        const sha1 = await jsosClient.getReference(name, namespace);
        const parentSha1 =
            (await jsosClient.getReference(sha1, VARIABLE_PARENT_KEY)) || null;
        let newVar;
        if (sha1) {
            newVar = new Variable(
                jsosClient,
                name,
                sha1,
                parentSha1,
                namespace,
                updateCallback
            );
        } else {
            const nullSha1 = await getSha1(await jsosClient.putObject(null));
            await jsosClient.putReference(name, namespace, nullSha1);
            newVar = new Variable(
                jsosClient,
                name,
                nullSha1,
                null,
                namespace,
                updateCallback
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

    getParent = async (): Promise<PersistentObject> => {
        const obj = await this.jsosClient.getPersistentObject(this.parentSha1);
        if (!obj) {
            throw Error(
                `Parent object with sha1 '${this.parentSha1}' not found in database`
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
        const parentSha1 = this.objectSha1; // capture this before we change it.
        const newVal = await currVal.update(updateFn);
        const childSha1 = getSha1(newVal);
        const afterSetting = await this.set(newVal);
        await this.jsosClient.putReference(
            childSha1,
            VARIABLE_PARENT_KEY,
            parentSha1
        );
        this.parentSha1 = parentSha1;
        return afterSetting;
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

export class PersistentObject implements PersistentObjectInterface {
    #jsosClient: JsosClient;
    #object: JObject;
    #normalizedObject: Json;
    sha1: string;

    private constructor(
        jsosClient: JsosClient,
        object: JObject,
        normalizedObject: Json,
        sha1: string
    ) {
        this.#jsosClient = jsosClient;
        // TODO: make a deep copy of `object` so ensure it can't be mutated outside of this class
        this.#object = object;
        this.#normalizedObject = normalizedObject;
        this.sha1 = sha1;
    }

    /* Use create pattern since constructor can't be async */
    static create = async (
        jsosClient: JsosClient,
        object: JObject
    ): Promise<PersistentObject> => {
        const normalizedObject = await jsosClient.putObject(object);
        const sha1 = getSha1(normalizedObject);
        return new PersistentObject(jsosClient, object, normalizedObject, sha1);
    };

    get jsosClient(): JsosClient {
        return this.#jsosClient;
    }

    get object(): JObject {
        return this.#object;
    }

    get normalizedObject(): Json {
        return this.#normalizedObject;
    }

    isPersistentObject(): true {
        return true;
    }

    async update(
        updateFn: (currVal: JObject) => Promise<JObject>
    ): Promise<PersistentObject>;
    async update(updateFn: (currVal: JObject) => JObject);
    async update(
        updateFn: (currVal: JObject) => Promise<JObject> | JObject
    ): Promise<PersistentObject> {
        let newVal;
        if (isAsyncFn(updateFn)) {
            newVal = await updateFn(this.object);
        } else {
            newVal = updateFn(this.object);
        }
        return PersistentObject.create(this.jsosClient, newVal);
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

export class OldPersistentOrderedMap<K, V> {
    /*
    A persistant ordered map that uses Jsos to stores its data in a supabase table.
    Each value is stored into Jsos as a separate object, and the map stores the
    sha1 of each value. The map itself is stored as an Array<Array> in Jsos, e.g:
      [["key1", "ref:acf928ad927..."],["key2", "ref:28cf9ad297a..."], ...]
    */
    jsosClient: JsosClient;
    map: OrderedMap<K, V>;
    sha1: string;

    private constructor(
        jsosClient: JsosClient,
        orderedMap: OrderedMap<K, V>,
        sha1: string
    ) {
        this.jsosClient = jsosClient;
        this.map = OrderedMap(orderedMap);
        this.sha1 = sha1;
    }

    static create = async <K, V>(
        jsosClient: JsosClient,
        ...args
    ): Promise<OldPersistentOrderedMap<K, V>> => {
        const map = OrderedMap<K, V>(...args);
        const sha1 = getSha1(await jsosClient.putObject(map.toArray()));
        return new OldPersistentOrderedMap(jsosClient, map, sha1);
    };

    async set(key: K, value: V): Promise<OldPersistentOrderedMap<K, V>> {
        const newMap = OldPersistentOrderedMap.create<K, V>(
            this.jsosClient,
            this.map.set(key, value)
        );
        return newMap;
    }

    async setIn(
        keyPath: Iterable<K>,
        value: V
    ): Promise<OldPersistentOrderedMap<K, V>> {
        const newMap = OldPersistentOrderedMap.create<K, V>(
            this.jsosClient,
            this.map.setIn(keyPath, value)
        );
        return newMap;
    }

    async get(key: K): Promise<V | undefined> {
        return this.map.get(key);
    }

    async equals(other: OldPersistentOrderedMap<K, V>): Promise<boolean> {
        // this could alternatively be: this.map.equals(other.map)
        return this.sha1 === other.sha1;
    }
}

/* TODO: Make a SharedOrderedMap that uses the Supabase subscription
         feature to keep the map in sync across multiple clients.
         SharedOrderedMap is an abstraction on top of a lineage of
         descendent PersisententOrderedMaps; and it gets an async
         callback when remote "updates" occur to the map, that it passes
         on to it own subscribers, like react components. Since our
         underlying data structure is immutable, the underlying map
         isn't actually updated, but rather a new "child" map is created
         and that is what is passed to the callback. The SharedOrderedMap
         learns about the creation of new children via the supabase
         subscription feature.
 */

const jsos = new JsosClient(supabase);
export default jsos;
