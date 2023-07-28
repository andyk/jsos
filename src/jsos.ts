import { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { Collection, OrderedMap, List } from "immutable";
import hash from "object-hash";
import supabase from "./supabase";
import _ from "lodash";
import fs from "fs";

type Json = string | number | boolean | null | { [key: string]: Json } | Json[];
type JObject = Json | Collection<any, any> | undefined;

// Re-using seriealization special keys from
// https://github.com/glenjamin/transit-immutable-js
const ORDERED_MAP_KEY = "~#iOM";
const LIST_KEY = "~#iL";
const DENORMALIZED_OBJECT_KEY = "~#N"; // This one is our own invention.
// TODO: add Map (iM), Set (iS), OrderedSet (iO), Stack (iStk), ??? and Null (_) ???

function isPlainObject(obj): obj is { [key: string]: any } {
    return (
        typeof obj === "object" &&
        obj !== null &&
        !Array.isArray(obj) &&
        Object.prototype.toString.call(obj) === "[object Object]"
    );
}

function isPersistentObject(obj): obj is PersistentObject {
    return obj?.isPersistentObject?.();
}

function loadCache(cacheFilename: string) {
    if (fs.existsSync(cacheFilename)) {
        const cacheData = fs.readFileSync(cacheFilename, "utf8");
        return JSON.parse(cacheData);
    } else {
        return {};
    }
}

const OBJ_CACHE_FILE_PATH = "./objectCache.json";
let objectCache = loadCache(OBJ_CACHE_FILE_PATH);

export function getSha1(o: any): string {
    if (o && typeof o.sha1 === "string") {
        return o.sha1;
    }
    return hash(o, { algorithm: "sha1", encoding: "hex" });
}

export function cacheObject(object): [Json, string] {
    const sha1 = getSha1(object);
    objectCache[sha1] = object;
    fs.writeFileSync(OBJ_CACHE_FILE_PATH, JSON.stringify(objectCache));
    return [object, sha1];
}

const REF_CACHE_FILE_PATH = "./referenceCache.json";
let referenceCache = loadCache(REF_CACHE_FILE_PATH);

export function cacheReference(
    name: string,
    namespace: string,
    sha1: string
): boolean {
    referenceCache[name + "-" + namespace] = sha1;
    fs.writeFileSync(REF_CACHE_FILE_PATH, JSON.stringify(referenceCache));
    return true;
}

export function getCachedReference(
    name: string,
    namespace: string
): string | undefined {
    return referenceCache[name + "-" + namespace];
}

export class JsosClient {
    supabaseClient: SupabaseClient;
    objectsTableName: string;
    normalizeTableName: string;
    variablesTableName: string;

    constructor(
        supabaseClient: SupabaseClient,
        objectsTableName: string = "jsos_objects",
        normalizeTableName: string = "jsos_normalize",
        variablesTableName: string = "jsos_variables"
    ) {
        this.supabaseClient = supabaseClient;
        this.objectsTableName = objectsTableName;
        this.normalizeTableName = normalizeTableName;
        this.variablesTableName = variablesTableName;
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
        if (json && typeof json === "object" && denormalizedJson && typeof denormalizedJson === "object") {
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
        console.log("putObject: ", object);
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
        let denormalizedSha1 = cacheObject(object)[1];
        if (denormalizedSha1 !== sha1) {
            cacheReference(sha1, DENORMALIZED_OBJECT_KEY, denormalizedSha1);
        }
        return writtenNormalized;
    }

    getReference = async (
        name: string,
        namespace: string | null = null
    ): Promise<string | undefined> => {
        let { data: row, error } =
            namespace === null
                ? await this.supabaseClient
                      .from(this.variablesTableName)
                      .select("object")
                      .eq("name", name)
                      .is("namespace", namespace) // Use .is because name is NULL
                      .maybeSingle()
                : await this.supabaseClient
                      .from(this.variablesTableName)
                      .select("object")
                      .eq("name", name)
                      .eq("namespace", namespace) // Use .eq because name is NOT NULL
                      .maybeSingle();
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
            .from(this.variablesTableName)
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

    variable = async (
        name: string,
        namespace: string | null = null
    ): Promise<Variable> => {
        return Variable.create(this, name, namespace);
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
    supabaseSubcription: RealtimeChannel | null;

    constructor(
        jsosClient: JsosClient,
        name: string,
        object: string,
        namespace: string | null = null,
        updatedCallback?: (newObject: any, newSha1: string) => void
    ) {
        this.jsosClient = jsosClient;
        this.name = name;
        this.namespace = namespace;
        this.objectSha1 = object;
        //Subscribe to updates from supabase.
        this.supabaseSubcription = this.jsosClient.supabaseClient
            .channel("any")
            .on(
                "postgres_changes",
                {
                    event: "*",
                    schema: "public",
                    table: this.jsosClient.variablesTableName,
                    filter: `name=eq.${name}`,
                },
                (payload) => {
                    console.log(
                        `got update for var name ${name} from supabase realtime: `,
                        payload
                    );
                    if (payload.new["namespace"] === this.namespace) {
                        this.objectSha1 = payload.new["object"];
                    }
                    if (updatedCallback) {
                        updatedCallback(this.get(), payload.new["object"]);
                    }
                }
            )
            .subscribe();
    }

    static create = async (
        jsosClient: JsosClient,
        name: string,
        namespace: string | null = null,
        updatedCallback?: (newObject: any, newSha1: string) => void
    ): Promise<Variable> => {
        /* If this variable exists already, fetch & return it. Else create it and
         * initialize it to wrap PersistentObject(null) */
        const sha1 = await jsosClient.getReference(name, namespace);
        if (sha1) {
            return new Variable(
                jsosClient,
                name,
                sha1,
                namespace,
                updatedCallback
            );
        } else {
            const nullSha1 = await getSha1(await jsosClient.putObject(null));
            await jsosClient.putReference(name, namespace, nullSha1);
            return new Variable(
                jsosClient,
                name,
                nullSha1,
                namespace,
                updatedCallback
            );
        }
    };

    unsubscribeFromSupabaseUpdates = () => {
        if (this.supabaseSubcription) {
            this.jsosClient.supabaseClient.removeChannel(
                this.supabaseSubcription
            );
            this.supabaseSubcription = null;
        }
    };

    get = async () => {
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
        if (!isPersistentObject(newVal)) {
            newVal = await this.jsosClient.persistentObject(newVal);
        }
        const { error } = await this.jsosClient.supabaseClient
            .from(this.jsosClient.variablesTableName)
            .update({ object: newVal.sha1 })
            .eq("name", this.name)
            .eq("namespace", this.namespace)
            .eq("object", this.objectSha1);
        if (error) {
            throw error;
        }
        return newVal;
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
        return this.set(newVal);
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
        updateFn: (currVal: JObject) => JObject
    ): Promise<PersistentObject> {
        const newVal = await updateFn(this.#normalizedObject);
        if (typeof newVal === "object" && newVal === this.#normalizedObject) {
            throw new Error("updateFn must return a new object");
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
