import React from "react";
import jsos, { Var, JsosSession } from "./jsos";
import { SupabaseClient } from "@supabase/supabase-js";

type ResolvedType<T> = T extends Promise<infer R> ? R : never;

// By default, uses Browser's IndexedDB for ValStore and Browser's Local Storage
// for VarStore.
const useVar = (
    defaultVal?: any,
    options?: {
        name: string;
        namespace?: string;
        supabaseClient?: SupabaseClient;
    }
) => {
    // we have to wrap our Var in something since React tests to see if state
    // has changed using Object.is.
    let name = options?.name || "JsosDefaultVar";
    let namespace = options?.namespace;
    const jsosSess = React.useRef<JsosSession>(jsos);
    const [jsosVar, setJsosVar] = React.useState<null | any>({
        Var: { __jsosVarObj: defaultVal },
    });

    React.useEffect(() => {
        if (options?.supabaseClient) {
            jsosSess.current = jsos.addSupabase(options.supabaseClient)
        }
    }, []);

    React.useEffect(() => {
        (async () => {
            let fetchedVar = await jsosSess.current.getOrNewImmutableVar({
                name,
                namespace,
                defaultVal
            });
            setJsosVar({ Var: fetchedVar });
            console.log("finished init setAppData to: ", fetchedVar);
        })();
        const subscrID = jsosSess.current.subscribeToVar({
            name,
            namespace,
            callback: (newVar: Var) => {
                console.log("handleNewVar: ", newVar);
                setJsosVar((oldVal: any) => {
                    const updatedJsosVar = { Var: newVar };
                    console.log(
                        "setJsosVar(updatedJsosVar = ",
                        updatedJsosVar,
                        ")"
                    );
                    return updatedJsosVar;
                });
            },
        });
        console.log("subscribed to var: ", subscrID);
    }, [jsosSess]);

    React.useEffect(() => {
        console.log("jsosVar changed: ", jsosVar);
    }, [jsosVar]);

    async function updateVar(updateValOrFn: any) {
        const v = jsosVar["Var"];
        if (!v) {
            return;
        }
        if (!("__jsosUpdate" in v)) {
            console.log("skipping updateVar since {Var} is not a jsos Var ", v);
            return;
        }
        if (typeof updateValOrFn === "function") {
            console.log("about to update var via __jsosUpdate()")
            setJsosVar({ Var: await v.__jsosUpdate(updateValOrFn) });
            console.log("done updating var via __jsosUpdate()")
        } else {
            setJsosVar({ Var: await v.__jsosUpdate(() => updateValOrFn) });
        }
    }

    return [jsosVar?.Var?.__jsosVarObj, updateVar];
};

export default useVar;
