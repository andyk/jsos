import React from "react";
import { Var, JsosSession } from "./jsos";
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
        overwriteExisting?: boolean;
    }
) => {
    let name = options?.name || "JsosDefaultVar";
    let namespace = options?.namespace;
    const jsosSess = React.useRef<JsosSession>();
    const [jsosVar, setJsosVar] = React.useState<null | any>({
        Var: { __jsosVarObj: defaultVal },
    });
    const [localVarObj, setLocalVarObj] = React.useState<any>(defaultVal);
    const [subscriptionID, setSubscriptionID] = React.useState<string | null>();
    const [pendingChanges, setPendingChanges] = React.useState<number>(0);
    const [isUpdating, setIsUpdating] = React.useState<boolean>(false);
    const lastUpdatedVersion = React.useRef(0);
    const loadedOnce = React.useRef<boolean>(false);

    React.useEffect(() => {
        "in the ThoughtBox init useEffect"
        if (loadedOnce.current) {
            console.log("loadedOnce is true, skipping")
            return;
        }
        loadedOnce.current = true;
        // we have to wrap our Var in something since React tests to see if state
        // has changed using Object.is.
        let initSess: JsosSession;
        if (options?.supabaseClient) {
            console.log("initializing initSess from provided supabaseClient");
            initSess = new JsosSession().addInMemory().addBrowserLocalStorage().addSupabase(options.supabaseClient);
        } else {
            //initSess = getDefaultSession();
        }
        jsosSess.current = initSess;

        if (!jsosSess.current) {
            return;
        }
        console.log("jsosSess updated. jsosSess.current: ", jsosSess.current);
        console.log("Async getting init var from this JsosSession.");
        (async () => {
            let fetchedVar = await jsosSess.current!.getOrNewImmutableVar({
                name,
                namespace,
                defaultVal
            });
            if (options?.overwriteExisting) {
                console.log("immediately overwriting existing var with defaultVal")
                await fetchedVar.__jsosUpdate(() => defaultVal, subscriptionID ?? undefined);
            }
            setJsosVar({ Var: fetchedVar });
            setLocalVarObj(fetchedVar.__jsosVarObj)
            console.log("finished init setAppData to: ", fetchedVar);
        })();
        console.log("creating subscription to var for this updated jsosSession: ", jsosSess.current.jsonStores)
        setSubscriptionID(old => {
            const newSubscrID = jsosSess.current!.subscribeToVar({
                name,
                namespace,
                callback: (updatedVar: Var) => {
                    console.log("handling updatedVar inside subscribeToVar callback: ", updatedVar);
                    setJsosVar(() => {
                        const updatedJsosVar = { Var: updatedVar };
                        console.log("in setJsosVar(), updatedJsosVar: ", updatedJsosVar);
                        return updatedJsosVar;
                    });
                    setLocalVarObj(updatedVar.__jsosVarObj)
                },
            })
            console.log("in setSubscriptionID, subscribing to var ", newSubscrID);
            return newSubscrID;
        });
        return () => {
            console.log("in component unmount callback: unsubscribing from var ", subscriptionID);
            if (subscriptionID !== null) {
                jsosSess.current!.unsubscribeFromVar({ subscriptionID }); 
            }
        }
    }, []);

    React.useEffect(() => {
        console.log("subscribed to var: ", subscriptionID);
    }, [subscriptionID]);


    //React.useEffect(() => {
    //    setLocalVarObj(jsosVar?.Var?.__jsosVarObj);
    //}, [jsosVar]);

    const updateDatabase = async () => {
        if (isUpdating || pendingChanges === 0) {
            console.log("aborting update Database: isUpdating: ", isUpdating, ", pendingChanges: ", pendingChanges)
            return;
        }

        const v = jsosVar["Var"];
        if (!("__jsosUpdate" in v)) {
            console.log("skipping updateVar since {Var} is not a jsos Var ", v);
            return;
        }
    
        console.log(`in updateDatabase, ${pendingChanges} pending changes, isUpdating.current = ${isUpdating}. pushing new changes`)
        setIsUpdating(true);

        try {
            const currentVersion = pendingChanges;

            console.log("about to update var via __jsosUpdate(), subscriptionID: ", subscriptionID)
            setJsosVar({ Var: await v.__jsosUpdate(() => localVarObj, subscriptionID) });
            console.log("done updating var via __jsosUpdate().");
            console.log(`decrementing pendingChanges ${pendingChanges} by ${currentVersion}`)

            lastUpdatedVersion.current += currentVersion;
            setPendingChanges((prev) => prev - currentVersion);
        } catch (error) {
            console.error('Error updating database:', error);
            // Handle error as necessary
        } finally {
            console.log("setting isUpdating to false")
            setIsUpdating(false);
        } 
    };
    
    React.useEffect(() => {
        console.log(`in useEffect for pendingChanges, pendingChanges = ${pendingChanges}, lastUpdatedVersion.current = ${lastUpdatedVersion.current} `)
        if (pendingChanges > 0 && !isUpdating) {
            console.log("calling updateDatabase")
            updateDatabase();
        } else {
            console.log("not calling updateDatabase", pendingChanges, lastUpdatedVersion.current, isUpdating)
        }
    }, [localVarObj, pendingChanges, isUpdating]);

    async function updateVar(updateValOrFn: any) {
        console.log("in updateVar");
        const v = jsosVar["Var"];
        if (!v) {
            return;
        }
        setLocalVarObj(updateValOrFn);
        console.log("updated localVarObj");
        setPendingChanges(old => old + 1);
    }

    return [localVarObj, updateVar];
};

export default useVar;
