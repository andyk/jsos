/*
If you don't need or want to use global state via context providers, consider
`useVar()` instead of `useVarContext()`.

To use this component, wrap your app in a JsosContextProvider, like so:

    <JsosContextProvider name="myVar">
        <App />
    </JsosContextProvider>

Then inside any component:

    const [myVar, setMyVar] = useVarContext();  // Behaves like useState()

This is a React hook that behaves a lot like React's native useState().

Be default, IndexedDB is used for the ValStore, and Local Storage
is used as the default VarStore. In JSOS, a `Var` is an abstraction for
providing an optionally sharable human readable reference to a Value, and
Values are efficiently content addressed immutable objects.

To use supabase for both the ValStore and VarStore, use

    <JsosContextProvider name="myVar" supabaseAPIKey="YOUR_KEY_HERE">
*/
import React, { useContext} from "react";
import { NotUndefined } from "./jsos";
import useVar from "./useVar";

export const VarContext = React.createContext<Array<NotUndefined>>(
    []
);

export function useVarContext(initialState: any): Array<any> {
  const context = useContext(VarContext);

  if (context === undefined) {
    throw new Error("useVarContext must be used inside a JsosContextProvider");
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
    const [appData, setAppData] = useVar(name, namespace);
    return (
        <VarContext.Provider value={[appData.Var, setAppData]}>
            {children}
        </VarContext.Provider>
    );
}
