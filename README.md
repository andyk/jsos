# JSOS (Javascript Object Store)
## Transparent Object Persistence for JavaScript

This is a Javascript/Typescript client for JSOS (JavaScript Object Store), which is a language agnostic framework for transparent object persistence and sharing.

This implementation supports persisting Javascript objects to multiple types of JSON object stores, including:
* Built-in Browser persistent storage (IndexDB & LocalStorage)
* Local FileSystem based JSON file storage - For use via Javascript in Node.
* [Supabase](https://supabase.com) - which is an open source wrapper around Postgres, PostgREST, a Websockets server, etc.)

The goal is to make an efficient object store that requires nearly no code to start using.

By using a Jsos "Var", your Javascript objects are transparently serialized and stored to (one or more) undelying ObjectStore implementations (e.g. to a Postgres JSONB column).

The two most important concepts in JSOS are _**Var**_ and _**Val**_.
* Under the hood objects are stored as immutable Jsos _**Vals**_. Objects are automatically normalized (which means that all nested objects are broken out into their own entry in the undelying JsonStore and replaced with their address) and serialized to persistent storage (via a "put" command) and then read, deserialized, and denormalized back to their original form (via the "get" operation). We use content-based-hashing which allows for easy sharing of immutable state.
* A _**Var**_ is a mutable shared human readable reference to a Var. I.e., it is a tuple of (namespace/name, hash_of_val). Var 

