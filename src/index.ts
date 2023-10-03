import jsos, { JsosSession, Val, Var, NewVal, getVar, newVar, getOrNewVar } from "./jsos";
import JsosContextProvider, { useVarContext } from "./JsosContext";
import JsosUI from "./JsosUI";
import useVar from "./useVar";
import { createSupaClient } from "./supabase";

export {
    JsosSession,
    JsosContextProvider,
    useVarContext,
    useVar,
    Val,
    Var,
    NewVal,
    getVar as GetVar,
    newVar as NewVar,
    getOrNewVar as GetOrNewVar,
    createSupaClient,
    JsosUI,
};

export default jsos;