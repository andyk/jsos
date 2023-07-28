import { createClient } from "@supabase/supabase-js";

const anonKey =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqdHRqanpxc2tmbmFqbGhzY3NjIiwicm9sZSI6ImFub24iLCJpYXQiOjE2OTA0OTY5MDksImV4cCI6MjAwNjA3MjkwOX0.fmhcsjwWTAvG3XwEZOzjTGa37S--iwk6WvUFeYj9Ofo";
const supabaseEnvKey = process.env.SUPABASE_JSOS_SERVICE_ROLE_KEY;
const supabaseKey = supabaseEnvKey ? supabaseEnvKey : anonKey;
const supabase = createClient(
    "https://kjttjjzqskfnajlhscsc.supabase.co",
    supabaseKey,
    {
        // https://github.com/supabase/supabase-js/issues/684
        auth: {
          persistSession: false,
        }, 
    }
);

export default supabase;
