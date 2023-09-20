import { createClient } from "@supabase/supabase-js";

type CreateClientType = typeof createClient;

const createSupaClient: CreateClientType = (
    supabaseUrl,
    supabaseKey,
    options?
) => {
    // https://github.com/supabase/supabase-js/issues/684
    // We could alternatively use LocalStorage lib for node.
    if (options?.auth?.persistSession === undefined) {
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
    } else {
        if (typeof window !== "undefined") {
            if (options.auth.persistSession === false) {
                throw Error("persistSession must be true in browser");
            }
        } else {
            if (options.auth.persistSession === true) {
                throw Error("persistSession must be false in node.");
            }
        }
    }
    return createClient(
        supabaseUrl,
        supabaseKey,
        options
    );
}

export default createSupaClient;
