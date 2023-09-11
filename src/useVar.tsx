import React, { useEffect }  from 'react';
import { GetOrNewVar, GetVar } from './jsos';

type ResolvedType<T> = T extends Promise<infer R> ? R : never;

// By default, uses Browser's IndexedDB for ValStore and Browser's Local Storage
// for VarStore.
const useVar = (name: string, namespace?: string, defaultVal?: any) => {
    // we have to wrap our Var in something since React tests to see if state
    // has changed using Object.is.
    const [jsosVar, setJsosVar] = React.useState<null | any>({ Var: defaultVal });

    function varChanged(
        varChangedName: string,
        varChangedNamespace: string | null,
        newSha1: string | null,
        oldSha1: string
    ) {
        console.log("varChanged triggered: ", varChangedName, varChangedNamespace, oldSha1, newSha1);
        if (name !== varChangedName || namespace !== varChangedNamespace) {
            console.log("useVar(", name, ", ", namespace, " got update tha we don't care about: ", varChangedName, varChangedNamespace);
            return;
        }
        setJsosVar(async ({ Var }: { Var: any }) => {
            const newVar = await GetVar({ name, namespace });
            console.log("setting Var to: ", Var, "newVar === oldvar: ", newVar === Var);
            return { newVar };
        });
    }

    useEffect(() => {
        (async () => {
            let fetchedVar = await GetOrNewVar({
                name,
                namespace,
                defaultVal,
                autoPullUpdates: true,
                callback: varChanged,
            });
            setJsosVar({ Var: fetchedVar });
        })();
    }, []);

    async function updateVar(updateValOrFn: any) {
        const v = jsosVar["Var"];
        if (!v) {
            return;
        }
        if (typeof updateValOrFn === "function") {
            await v.__jsosUpdate(updateValOrFn);
        } else {
            await v.__jsosUpdate(() => updateValOrFn);
        }
        console.log("successfully updated var: ", name, namespace, jsosVar);
        setJsosVar({ Var: v });
    }

    return [jsosVar.Var.__jsosVarObj, updateVar];
}

export default useVar;