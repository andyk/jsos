import React, { useRef, useEffect, useState } from 'react';
import jsos, { Var, JsonStore } from "./jsos";

export default function JsosUI({ }) {
    const [varNameSearch, setVarNameSearch] = useState("");
    const [varNamespaceSearch, setVarNamespaceSearch] = useState("");
    const [foundVar, setFoundVar] = useState<Var | null | undefined>(null);
    const j = useRef(jsos);

    useEffect(() => {
        try {
            j.current.addSupabaseFromEnv();
        } catch (e) {
            console.log("Failed to add Supabase from env: ", e);
        }
    }, []);

    useEffect(() => {
        j.current.getVar<Var>({ name: varNameSearch, namespace: varNamespaceSearch }).then((v) => {
            console.log("searching for var: ", varNameSearch, " found: ", v);
            setFoundVar(v);
        });
    }, [varNameSearch, varNamespaceSearch]);

    return (
        <>
        <div>
            JsonStores:
            {j.current.jsonStores.length ? "" : " No JsonStores."}
            {j.current.jsonStores.map((jStore: JsonStore, i: number) => {
                return <li key={i}>{jStore.constructor.name}</li>;
            })}
            {j.current.jsonStores.length ? "" : " No JsonStores."}
        </div>
        <div>
            <div>ValStore:</div>
                {j.current.valStore ? (<li>{j.current.valStore.constructor.name}</li>) : " No ValStore."}
        </div>
        <div>
            VarStore:
                {j.current.varStore ? (<li>{j.current.varStore.constructor.name}</li>) : "No VarStore"}
        </div>
        <div>
            Search For Var:
            <div>
                Name: <input onChange={(e) => {
                    setVarNameSearch(e.target.value);
                }}></input><br/>
            </div>
            <div>
                Namespace: <input onChange={(e) => {
                    setVarNamespaceSearch(e.target.value);
                }}>
                </input><br />
            </div>
            <div>
                    {foundVar ? (<code>{JSON.stringify(foundVar, null, 2)}</code>) : "not found"}
            </div>
                {foundVar ? (
                    <button onClick={() => {
                        (async () => {
                            if (await j.current.deleteVar({ name: varNameSearch, namespace: varNamespaceSearch })) {
                                setFoundVar(null);
                            }
                        })();
                    }}>
                        delete ({varNameSearch}, {varNamespaceSearch || "null"})
                    </button>
                ) : <></>}
        </div>
        </>
    );
}
