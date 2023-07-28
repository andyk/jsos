# jsos-js - JavaScript Object Store (JSOS) / Javascript Client

This is a Javascript client for JSOS, which is a wrapper around [Supabase](https://supabase.com) (which itself is an open source wrapper around Postgres, PostgREST, a Websockets server, etc.) and the [Javascript Immutables](https://immutable-js.com) library of datastructures.

The aim is to provide ORM-like functionality akin to an Object Database.

Javascript objects are autmatically serialized to a Postgres JSONB column and addressed via the hash of their contents.
