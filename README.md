# JSOS (Javascript Object Store)
## Object Persistence for JavaScript

JSOS (JavaScript Object Store) is a framework for easily persisting and sharing javascript objects.

**Install**
```
npm install @andykon/jsos
```

**Basic Usage**
```
$ node
Welcome to Node.js
Type ".help" for more information.
> const { default: jsos } = await import("@andykon/jsos");
> class Person {
... name
... constructor(name) {
...   this.name = name
... }
... sayHi() {
...   return `hi, my name is ${this.name}` 
... }
...}
> andy = await jsos.newVar({name: "myVar", val: new Person("Andy")})
> andy.sayHi()
hi, my name is Andy
> andy.name = "Randy" // changes to the Var automatically persist to the underlying filesystem storage.

// Now, kill your node REPL. Then restart it.
$ node
> const { default: jsos } = await import("@andykon/jsos");
> andy = await jsos.GetVar({name: "myVar"})
> andy.name
Randy
> andy.sayHi()
hi, my name is Randy
```

# Intro
JSOS provides persistence and sharing of Javascript objects without requiring any decorations or extra code from the developer.

The goal is to take (nearly) any JS/Typescript object or value and let you interact with it as you normally would, while transparently persisting it to a variety of object stores (e.g., filesystem, browser persistent storage, Postgres, etc.).

Another way to think of it is: what would it be like if SSD & hard disk storage was just another layer of the memory hierarchy, like main memory.

# Supported Types
Supports the following types of Javascript... "things":
* Objects (including prototype chain, preserves property descriptors)
* Classes & class instances
* Primitives, Arrays, POJOs, Set, Map
* Date, RegExp
* [Immutable.js](https://immutable-js.com/) objects (except for Record which is a TODO)
* functions (serialization does not currently capture non-local scope)

# Supported Object Stores
* Built-in Browser persistent storage (IndexDB & LocalStorage)
* Local FileSystem based JSON file storage - For use via Javascript in Node.
* [Supabase](https://supabase.com) - which is an open source wrapper around Postgres, PostgREST, a Websockets server, etc.)

## Project Goals
* Allow developer to turn an in-memory object/primitive/etc. into an object that is automagically persisted (e.g., to the filesystem or a network service) without having to write any extra code.
* Support many object stores out of the box; easy to add new ones.
* Make it efficient to persist large & deeply nested objects (don't duplicate entire object for each change)

## Non-goals
* This is not an Object Relational Mapper (ORM). While we support using a DBMS as a JSON key-value, we do not try to map any object oriented concepts to relational ones.

## Quick Summary
To get started, you can use a JSOS `Var` to turn your JS "value" (which can be an object, class, primitive, data structure, etc.) into a "transparently persisted" equivalent of itself. For the types that support mutations (or transformations via an immutable-style interface)--i.e., things other than primitives--at each mutation/transformation (either via a mutable `Var` or `ImmutableVar`), the new updated is transparently serialized and stored to (one or more) undelying ObjectStore implementations (e.g. to a Postgres JSONB column) as a new `Val`.

## Using Supabase
To use Supabase as a backend for Jsos, you need to...

1. Create 2 tables: one for the "vals" (map from hash to json object) and one for the "vars" (map from name, namespace to hash).
2. Set up RPC's (i.e. create postgres functions) that allow for batched reads/writes of "vals".
3. Increase the API row limit from 1000 (till we implement pagination)
4. Set environment variables

### Set up the necessary tables
Set up a Supabase project that has the two simple tables: `jsos_objects` and `jsos_vars` with the schemas as follows:

```
create table
  public.jsos_objects (
    hash text not null,
    json jsonb null,
    constraint jsos_objects_pkey primary key (hash)
  ) tablespace pg_default;
```

```
create table
  public.jsos_vars (
    name text not null,
    namespace text null,
    val_hash text not null,
    constraint jsos_variables_pkey primary key (name)
  ) tablespace pg_default;
```

### Set up RPC's (i.e. create postgres functions)
running the following commands in postgres will create functions that JSOS uses for batched reads/writes of "vals"

#### Create put_jsons

```
-- If you end up re-runing this command, comment this line out the second time
CREATE TYPE jsos_object_type AS (hash TEXT, json JSON);

CREATE OR REPLACE FUNCTION put_jsons(objects jsos_object_type[])
RETURNS SETOF jsos_objects AS $$
DECLARE
    object_record jsos_object_type;
    i INT;
BEGIN
    FOR i IN array_lower(objects, 1) .. array_upper(objects, 1)
    LOOP
        object_record := objects[i];

        INSERT INTO jsos_objects(hash, json) 
        VALUES (object_record.hash, object_record.json)
        ON CONFLICT (hash) DO NOTHING;  -- or DO UPDATE if you want to handle duplicates
    END LOOP;
    
    RETURN QUERY
    SELECT hash, json FROM jsos_objects WHERE hash IN (SELECT unnest.hash FROM unnest(objects) AS unnest);
END;
$$ LANGUAGE plpgsql;
```

#### Create get_hashes

```
CREATE OR REPLACE FUNCTION get_hashes(hashes text[]) 
RETURNS SETOF text AS $$
BEGIN
  RETURN QUERY
  SELECT hash FROM jsos_objects
  WHERE hash = ANY(hashes);
END;
$$ LANGUAGE plpgsql;
```

#### Create get_jsons

```
create or replace function get_jsons(hashes text[]) returns setof jsos_objects as $$
  select hash, json from jsos_objects
  where hash = any(hashes);
$$ language sql;
```

### Increase the API row limit from 1000 (till we implement pagination)
The max rows returned at one time from supabase API is limited by
a use configurable setting (within "API settings"), and the default is
1000. This will break large requests here. We should add pagination
but for now we will just increase that setting to 100,000.

This limit is documented in the supabase docs for the (`select` API)[https://supabase.com/docs/reference/javascript/select]
but it is also seems to apply to the RPC API.

The setting can be changed in Supbase web UI in the "API" setting box of the project.

### Set environment variables
The easiest way to have Jsos connect to Supabase (and use it as a JsonStore) is to set the following environment variables (which you can find under
"Project Settings" > "API"):

```
# You can set these in your ~/.profile to always have them available
# in your shell env.
SUPABASE_SERVICE_ROLE_KEY_JSOS="copy and paste from supabase web UI"
SUPABASE_URL_JSOS="copy and paste from supabase web UI"
```

If those env vars are set, then in node the SupabaseJsonStore should
automatically be created and added to the default `jsos` object (i.e.,
the default export of the jsos package, which is a `jsosSession` object).

```
$ node
> const { default: jsos } = await import("@andykon/jsos");
> jsos.valStore
ValStore {
  jsonStore: MultiJsonStore {
    jsonStores: [ [InMemoryJsonStore], [FileBackedJsonStore], [SupabaseJsonStore] ],
    autoCache: true
  }
}
```
## Architecture
![jsos-architecture-v3-2023-12-23](https://github.com/andyk/jsos/assets/228998/ef686d7f-f509-4992-b3fd-d027540743c4)


## Core Abstractions
* `Var` - Conceptually, this is a mutable shared human readable reference to a Val. Think of it as a potentially shared tuple of (name, hash_of_val). The main way you interact with this concept is by creating instances of the `Var` class.
* `Val` - An immutable content-addressed Object that is automatically normalized-then-serialized-then-written to persistent storage (via a "put") and then read-then-deserialized-then-denormalized back to their original form (via a "get") for the user to interact with.
  * We use content-based-hashing which allows for easy sharing of immutable state.
  * Normalization means that all nested objects are broken out into their own entry in the undelying JsonStore and replaced with their address
* `JsosSession` - an builder-style single entry point for composing VarStores + ValStore + JsonStores together and then using them to interact with (i.e.g put, read, delete, subscribe-to, etc.) `Var`s and `Val`s.
* `VarStore` - A wrapper around a transactional tuple store that handles storing and concurrently reading/updating/deleting a mapping between a human readable name/namespace and a hash of the object which can be found in a ValStore or JsonStore. VarStores serve three main purposes:
  1. give `Val`s human readable names
  2. provide a mutable abstraction over top of an immutable one (i.e., `Val`s)
  3. enable sharing of mutable state between multiple users (i.e., multiple users can co-edit a `Var`, each automatically receiving updates of the others changes).
* `ValStore` - A key-value store and a wrapper around a JsonStore. ValStores handle \[de\]serializing (i.e., encoding more complex types down into pure JSON), as well as \[de\]normalizing (i.e., breaking out nested objects into their own entries in the JsonStore). This is useful for supporting objects that JSON doesn't handle natively, as well as for encoding objects in a way that is more efficient or performant (e.g., normalizing objects prevents lots of redundant information from being sent over the network when only a tiny portion of a large object is updated).
* `JsonStore` - base class for wrappers around different object storage implementations (e.g., Filesystem, Browser IndexDB/LocalStorage, Postgres using JsonB column, etc.). These take JSON objects as keys and values and store them in the underlying key-value store using the hash of the JSON object as the key.

