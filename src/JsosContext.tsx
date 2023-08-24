import React, { useEffect } from "react";
import { Var, Val, GetOrNewVar } from "./jsos";

type ResolvedType<T> = T extends Promise<infer R> ? R : never;

export const DataContext = React.createContext<Array<Val | Function | null>>(
    []
);

export default function JsosContextProvider({
    children,
    name,
    namespace,
}: {
    children: React.ReactNode;
    name: string;
    namespace: string;
}) {
    const [jsosVar, setJsosVar] = React.useState<null | ResolvedType<ReturnType<typeof GetOrNewVar>>>(null);
    const [appData, setAppData] = React.useState<{ [key: string]: null | Val }>(
        { pObject: null }
    );

    function varChanged(
        name: string,
        namespace: string | null,
        newSha256: string | null,
        oldSha256: string
    ) {
        console.log("varChanged triggered: ", oldSha256, newSha256);
        setAppData({ pObject: jsosVar?.__jsosVal || null });
    }
    useEffect(() => {
        (async () => {
            let fetchedVar = await GetOrNewVar({
                name: "appData",
                namespace: "benw-trivia",
                defaultVal: null,
                callback: varChanged,
            });
            setJsosVar(fetchedVar);
            console.log("finished init setAppData to: ", fetchedVar);
        })();
    }, []);

    useEffect(() => {
        console.log("jsosVar changed: ", jsosVar);
        (async () => {
            let pObj = jsosVar?.__jsosVal || null;
            console.log("jsosVar update triggered: setting pObj: ", pObj);
            setAppData({ pObject: pObj });
        })();
    }, [jsosVar]);

    async function updatePObject(updateFun: (oldObj: any) => any) {
        if (jsosVar !== null) {
            jsosVar.__jsosUpdate(updateFun)
            setAppData({ pObject: jsosVar?.__jsosVal || null });
        }
    }

    return (
        <DataContext.Provider value={[appData.pObject, updatePObject]}>
            {children}
        </DataContext.Provider>
    );
}
