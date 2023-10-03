# JSOS (Javascript Object Store)
## Object Persistence for JavaScript

JSOS (JavaScript Object Store) is a framework for object serialization, persistence, and sharing.

**Install**
```
npm install @andykon/jsos
```

**Basic Usage**
```
$ node
Welcome to Node.js v20.5.1.
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
// Now, kill your node REPL

$ node
> const { default: jsos } = await import("jsos-js");
> andy = await jsos.GetVar({name: "myVar"})
> andy.name
Randy
> andy.sayHi()
hi, my name is Randy
```

Use this library to persist Javascript objects to multiple types of JSON key-value object stores, including:
* Built-in Browser persistent storage (IndexDB & LocalStorage)
* Local FileSystem based JSON file storage - For use via Javascript in Node.
* [Supabase](https://supabase.com) - which is an open source wrapper around Postgres, PostgREST, a Websockets server, etc.)

Supports the following types of Javascript objects:
* Objects (including prototype chain, preserves property descriptors)
* Classes & class instances
* Primitives, Arrays, POJOs, 
* Date, RegExp, Set, Map
* [Immutable.js](https://immutable-js.com/) objects
* functions (serialization does not currently capture non-local scope)


Project goals:
* support many object stores out of the box; easy to add new ones.
* make it efficient to persist large & deeply nested objects (don't duplicate entire object for each change)
* require nearly no code to start using

By using a Jsos `Var`, your Javascript objects are transparently serialized and stored to (one or more) undelying ObjectStore implementations (e.g. to a Postgres JSONB column).

Core Abstractions:
* `Var` - a mutable shared human readable reference to a Var. I.e., it is a tuple of (namespace/name, hash_of_val). Var 
* `Val` - An immutable content-addressed Object that is automatically normalized+serialized+written to persistent storage (via a "put" command) and then read+deserialized+denormalized back to their original form (via the "get" operation).
  * We use content-based-hashing which allows for easy sharing of immutable state.
  * Normalization means that all nested objects are broken out into their own entry in the undelying JsonStore and replaced with their address

