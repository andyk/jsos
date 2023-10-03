# JSOS (Javascript Object Store)
## Object Persistence for JavaScript

JSOS (JavaScript Object Store) is a framework for transparent object serialization, persistence, and sharing.

**Example Install & Usage:**
```
$ git clone git@github.com:andyk/jsos-js.git
$ cd jsos-js
// make sure you have npm installed.
$ npm link // or npm pack; npm install jsos-<REST_OF_NAME_OF_NPM_TARBALL_PACKAGE>
$ node
Welcome to Node.js v20.5.1.
Type ".help" for more information.
> const { default: jsos } = await import("jsos-js");
> class Person {
... name
... constructor(name) {
...   this.name = name
... }
... sayHi() {
...   return `hi, my name is ${this.name}` 
... }
...}
> andy = await jsos.NewVar({name: "myVar", val: new Person("Andy")})
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

Project goals is to make an efficient object store that requires nearly no code to start using.

By using a Jsos "Var", your Javascript objects are transparently serialized and stored to (one or more) undelying ObjectStore implementations (e.g. to a Postgres JSONB column).

The two most important concepts in JSOS are _**Var**_ and _**Val**_.
* Under the hood objects are stored as immutable Jsos _**Vals**_. Objects are automatically normalized (which means that all nested objects are broken out into their own entry in the undelying JsonStore and replaced with their address) and serialized to persistent storage (via a "put" command) and then read, deserialized, and denormalized back to their original form (via the "get" operation). We use content-based-hashing which allows for easy sharing of immutable state.
* A _**Var**_ is a mutable shared human readable reference to a Var. I.e., it is a tuple of (namespace/name, hash_of_val). Var 

