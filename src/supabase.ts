import { createClient } from "@supabase/supabase-js";

// https://github.com/supabase/supabase-js/issues/684
// We could alternatively use LocalStorage lib for node.
let options;
if (typeof window !== "undefined") {
    // running in browser
    options = {
        auth: {
            persistSession: true,
        },
    };
} else {
    // running in node.js
    options = {
        auth: {
            persistSession: false,
        },
    };
}

const anonKey =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqdHRqanpxc2tmbmFqbGhzY3NjIiwicm9sZSI6ImFub24iLCJpYXQiOjE2OTA0OTY5MDksImV4cCI6MjAwNjA3MjkwOX0.fmhcsjwWTAvG3XwEZOzjTGa37S--iwk6WvUFeYj9Ofo";
// DO NOT COMMIT THIS KEY TO GITHUB
const supabaseServiceRoleKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqdHRqanpxc2tmbmFqbGhzY3NjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTY5MDQ5NjkwOSwiZXhwIjoyMDA2MDcyOTA5fQ.xj8RpsJIlO92iDdL5cQ_SM2prWN_K6Gvzt0qu4IawXM"
//const supabaseKey =
//    typeof process !== "undefined" && process.env.SUPABASE_JSOS_SERVICE_ROLE_KEY
//        ? process.env.SUPABASE_JSOS_SERVICE_ROLE_KEY
//        : anonKey;
//const supabaseEnvKey = process.env.SUPABASE_JSOS_SERVICE_ROLE_KEY;
//const supabaseKey = supabaseEnvKey ? supabaseEnvKey : anonKey;
const supabase = createClient(
    "https://kjttjjzqskfnajlhscsc.supabase.co",
    supabaseServiceRoleKey,
    options
);

export default supabase;
