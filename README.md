# jsos-js - JavaScript Object Store (JSOS) / Javascript Client

This is a Javascript client for JSOS, which is a wrappera round Supabase (Postgres, PostgREST, Websockers server, etc.) and the Javascript Immutables API.

The aim is to provide ORM-like functionality akin to an Object Database.

Javascript objects are autmatically serialized to a Postgres JSONB column and addressed via the hash of their contents.
