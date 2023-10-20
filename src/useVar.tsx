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
    const [localVarObj, setLocalVarObj] = React.useState<any>(defaultVal);
    const [subscrID, setSubscrID] = React.useState<string | null>(null);
    const [varUpdateQueue, setVarUpdateQueue] = React.useState<any[]>([]);
    const [updatePending, setUpdatePending] = React.useState<boolean>(false);

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
            setLocalVarObj(fetchedVar.__jsosVarObj)
            console.log("finished init setAppData to: ", fetchedVar);
        })();
        setSubscrID(
            jsosSess.current.subscribeToVar({
                name,
                namespace,
                callback: (updatedVar: Var) => {
                    console.log("handling updatedVar inside subscribeToVar callback: ", updatedVar);
                    setJsosVar((oldVal: any) => {
                        const updatedJsosVar = { Var: updatedVar };
                        console.log(
                            "setJsosVar(updatedJsosVar = ",
                            updatedJsosVar,
                            ")"
                        );
                        return updatedJsosVar;
                    });
                    setLocalVarObj(updatedVar.__jsosVarObj)
                },
            })
        );
        console.log("subscribed to var: ", subscrID);
    }, [jsosSess]);

    //React.useEffect(() => {
    //    setLocalVarObj(jsosVar?.Var?.__jsosVarObj);
    //}, [jsosVar]);

    async function attemptApplyUpdates() {
        if (varUpdateQueue.length === 0) {
            return;
        }
        console.log("in attemptApplyUpdates(), updatePending: ", updatePending);
        setUpdatePending(true);
        const v = jsosVar["Var"];
        console.log("varUpdateQueue: ", varUpdateQueue);
        let updateWrapper = function (oldVal: any) {
            console.log("in updateWrapper")
            let newVal: any;
            varUpdateQueue.forEach(updateValOrFn => {
                if (typeof updateValOrFn === "function") {
                    newVal = updateValOrFn(oldVal);
                } else {
                    newVal = updateValOrFn;
                }
            });
            console.log("batched updates: ", newVal)
            return newVal;
        }
        setJsosVar({ Var: await v.__jsosUpdate(updateWrapper, subscrID) });
        setVarUpdateQueue([]);
        setUpdatePending(false);
    }

    React.useEffect(() => {
        console.log("varUpdateQueue changed: ", varUpdateQueue);
        if (varUpdateQueue.length > 0) {
            attemptApplyUpdates();
        } else {
            "varUpdateQueue changed and is empty"
        }
    }, [varUpdateQueue]);

    React.useEffect(() => {
        if (updatePending) {
            console.log("updatePending, skipping attemptApplyUpdates");
            return;
        }
        attemptApplyUpdates();
    }, [updatePending]);

    async function updateVar(updateValOrFn: any) {
        const v = jsosVar["Var"];
        if (!v) {
            return;
        }
        setLocalVarObj(updateValOrFn);
        if (!("__jsosUpdate" in v)) {
            console.log("skipping updateVar since {Var} is not a jsos Var ", v);
            return;
        }
        setVarUpdateQueue((oldQueue) => {
            console.log("enqueuing updateValOrFn to varUpdateQueue");
            return [...oldQueue, updateValOrFn];
        });
    }

    return [localVarObj, updateVar];
};

export default useVar;
