import React, { useEffect }  from 'react';
import { GetOrNewImmutableVar, SubscribeToVar, Var } from './jsos';

type ResolvedType<T> = T extends Promise<infer R> ? R : never;

// By default, uses Browser's IndexedDB for ValStore and Browser's Local Storage
// for VarStore.
const useVar = (defaultVal?: any, options?: { name: string, namespace?: string } ) => {
    // we have to wrap our Var in something since React tests to see if state
    // has changed using Object.is.
    let name = options?.name || "JsosDefaultVar";
    let namespace = options?.namespace;
    const [jsosVar, setJsosVar] = React.useState<null | any>({ Var: { __jsosVarObj: defaultVal } });

    useEffect(() => {
        (async () => {
            let fetchedVar = await GetOrNewImmutableVar({
                name,
                namespace,
                defaultVal,
            });
            setJsosVar({ Var: fetchedVar });
            console.log("finished init setAppData to: ", fetchedVar);
        })();
        SubscribeToVar({
            name,
            namespace,
            callback: (newVar: Var) => {
                console.log("handleNewVar: ", newVar);
                setJsosVar((oldVal: any) => {
                    const updatedJsosVar = { Var: newVar };
                    console.log("setJsosVar(updatedJsosVar = ", updatedJsosVar, ")")
                    return updatedJsosVar;
                });
            }
        });
    }, []);

    async function updateVar(updateValOrFn: any) {
        const v = jsosVar["Var"];
        if (!v) {
            return;
        }
        if (! ("__jsosUpdate" in v)) {
            console.log("skipping updateVar since {Var} is not a jsos Var ", v);
            return;
        }
        if (typeof updateValOrFn === "function") {
            setJsosVar({ Var: await v.__jsosUpdate(updateValOrFn) });
        } else {
            setJsosVar({ Var: await v.__jsosUpdate(() => updateValOrFn) });
        }
        console.log("successfully updated var: ", name, namespace, jsosVar);
    }

    return [jsosVar?.Var?.__jsosVarObj, updateVar];
}

export default useVar;