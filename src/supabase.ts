import { createClient } from "@supabase/supabase-js";

type CreateClientType = typeof createClient;

//export type Json =
//  | string
//  | number
//  | boolean
//  | null
//  | { [key: string]: Json }
//  | Json[]
//
//interface JsosDatabase { 
//    public: {
//        Tables: {
//            jsos_objects: {
//                Row: {
//                    hash: string,
//                    json: Json
//                }
//            },
//            jsos_vars: {
//                Row: {
//                    name: string,
//                    namespace: string,
//                    val_hash: string,
//                }
//            }
//        }
//    }
//}

export const createSupaClient: CreateClientType = (
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

export const supaClientFromEnvNodeOnly = (
        supabaseUrlEnvName?: string,
        supabaseKeyEnvName?: string
) => {
    const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;
    if (!isNode) {
        throw Error("supaClientFromEnvBrowser only works in node.js");
    }

    const urlEnvName = supabaseUrlEnvName || "SUPABASE_URL_JSOS" 
    const keyEnvName = supabaseKeyEnvName || "SUPABASE_SERVICE_ROLE_KEY_JSOS"
    let supabaseProjectUrl;
    let supabaseEnvKey;
    try {
        supabaseProjectUrl = process.env[urlEnvName];
        supabaseEnvKey = process.env[keyEnvName];
    } catch (e) {
        //console.log("supabase env vars not found via process.env... ", e)
    }
    if (supabaseEnvKey === undefined || supabaseProjectUrl === undefined) {
        throw Error(
            `SUPABASE_JSOS_SERVICE_ROLE_KEY=${supabaseEnvKey}, ` +
            `SUPABASE_JSOS_PROJECT_URL=${supabaseProjectUrl}; but ` +
            "both must be defined in environment."
        );
    }
    return createSupaClient(
        supabaseProjectUrl,
        supabaseEnvKey
    );
}
