/*
If you don't need or want to use global state, consider `useVar()` instead
of `useVarContext()`.

To use this component, wrap your app in a JsosContextProvider, like so:

    <JsosContextProvider name="myVar">
        <App />
    </JsosContextProvider>

Then inside any component:

    const [myVar, setMyVar] = useDataContext();  // Behaves like useState()

This is a React hook that behaves a lot like React's native useState().

Be default, IndexedDB is used for the ValStore, and Local Storage
is used as the default VarStore. In JSOS, a `Var` is an abstraction for
providing an optionally sharable human readable reference to a Value, and
Values are efficiently content addressed immutable objects.

To use supabase for both the ValStore and VarStore, use

    <JsosContextProvider name="myVar" supabaseAPIKey="YOUR_KEY_HERE">
*/
import React, { useEffect } from "react";
import { useContext } from "react";
import { Val, GetOrNewVar } from "./jsos";

type ResolvedType<T> = T extends Promise<infer R> ? R : never;

export const VarContext = React.createContext<Array<Val | Function | null>>(
    []
);

export function useDataContext<S>(initialState: Val | (() => Val)): Array<Val | Function | null> {
  const context = useContext(VarContext);

  if (context === undefined) {
    throw new Error("useData must be used inside a DataProvider");
  }

  return context;
};

export default function JsosContextProvider({
    children,
    name,
    namespace,
}: {
    children: React.ReactNode;
    name: string;
    namespace?: string;
}) {
    const [jsosVar, setJsosVar] = React.useState<null | ResolvedType<ReturnType<typeof GetOrNewVar>>>(null);
    const [appData, setAppData] = React.useState<{ [key: string]: null | Val }>(
        { pObject: null }
    );

    function varChanged(
        name: string,
        namespace: string | null,
        newSha1: string | null,
        oldSha1: string
    ) {
        console.log("varChanged triggered: ", oldSha1, newSha1);
        setAppData({ pObject: jsosVar?.__jsosVal || null });
    }

    useEffect(() => {
        (async () => {
            let fetchedVar = await GetOrNewVar({
                name,
                namespace,
                defaultVal: { games: {}},
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
        console.log("in updatePObject, jsosVar is:", jsosVar);
        if (jsosVar !== null) {
            await jsosVar.__jsosUpdate(updateFun)
            setAppData({ pObject: jsosVar?.__jsosVal || null });
            console.log("successfully setAppData in updatePObject()");
        }
    }

    return (
        <VarContext.Provider value={[appData.pObject, updatePObject]}>
            {children}
        </VarContext.Provider>
    );
}
