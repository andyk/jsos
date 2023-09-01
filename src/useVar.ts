import React, { useEffect }  from 'react';
import { GetOrNewVar } from './jsos';

type ResolvedType<T> = T extends Promise<infer R> ? R : never;

// By default, uses Browser's IndexedDB for ValStore and Browser's Local Storage
// for VarStore.
const useVar = (name: string, namespace?: string, defaultVal?: any) => {
    // we have to wrap our Var in something since React tests to see if state
    // has changed using Object.is.
    const [jsosVar, setJsosVar] = React.useState<null | any>({Var: null});

    function varChanged(
        name: string,
        namespace: string | null,
        newSha1: string | null,
        oldSha1: string
    ) {
        console.log("varChanged triggered: ", name, namespace, oldSha1, newSha1);
        setJsosVar(({ Var }: { Var: any }) => {
            Var.__jsosPull();
            return { Var };
        });
    }

    useEffect(() => {
        (async () => {
            let fetchedVar = await GetOrNewVar({
                name,
                namespace,
                defaultVal,
                autoPullUpdates: false,
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

    return [jsosVar.Var, updateVar];
}

export default useVar;