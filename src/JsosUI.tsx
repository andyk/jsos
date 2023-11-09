import React, { useEffect, useState } from "react";
import { Var, JsonStore, JsosSession, getDefaultSession } from "./jsos";
import { createSupaClient } from "./supabase";

export default function JsosUI({ supabaseClient }: { supabaseClient?: any }) {
    const [varNameSearch, setVarNameSearch] = useState("");
    const [varNamespaceSearch, setVarNamespaceSearch] = useState("");
    const [foundVar, setFoundVar] = useState<Var | null | undefined>(null);
    const [jsos, setJsos] = useState<JsosSession>();
    const [supabaseUrl, setSupabaseUrl] = useState<string>('');
    const [supabaseApiKey, setSupabaseApiKey] = useState<string>('');

    useEffect(() => {
        setJsos((old) => {
            let retVal = old === undefined ? new JsosSession() : old
                .reset()
                .addInMemory()
                .addBrowserLocalStorage()
            console.log("retVal reset to: ", retVal)
            if (supabaseUrl !== '' && supabaseApiKey !== '') {
                try {
                    const supaClient = createSupaClient(supabaseUrl, supabaseApiKey)
                    return retVal.addSupabase(supaClient)
                } catch (e) {
                    console.log("SupaClient creation failed", e)
                }
            }
            if (supabaseClient) {
                console.log("Using `supabaseClient` attribute passed to JsosUI", supabaseClient);
                return retVal.addSupabase(supabaseClient)
            } else {
                console.log("using default session.");
                return retVal
            }
        })
    }, [supabaseClient, supabaseUrl, supabaseApiKey])

    useEffect(() => {
        jsos?.getVar<Var>({ name: varNameSearch, namespace: varNamespaceSearch })
            .then((v) => {
                if (v !== undefined) {
                    setFoundVar(v);
                }
            });
    }, [jsos, varNameSearch, varNamespaceSearch]);

    return (
        <>
            <div>
                {supabaseClient ? null :
                    <>
                        <div><i>SupabaseClient not provided</i></div>
                        <div style={{paddingTop:5}}><b>SupabaseClient Credentials:</b></div>
                        <div>Supabase URL:&nbsp;
                            <input
                                type={"text"}
                                value={supabaseUrl}
                                onChange={(e) => setSupabaseUrl(e.target.value)}
                        />
                        </div>
                        <div>Supabase API Key:&nbsp;
                            <input
                                type={"text"}
                                value={supabaseApiKey}
                                onChange={(e) => setSupabaseApiKey(e.target.value)}
                            />
                        </div>
                    </>
                }
            </div>
            <div style={{ paddingTop: 20 }}>
                <b>JsonStores:</b>
                {jsos?.jsonStores.length ? "" : " No JsonStores."}
                {jsos?.jsonStores.map((jStore: JsonStore, i: number) => {
                    return <li key={i}>{jStore.constructor.name}</li>;
                })}
                {jsos?.jsonStores.length ? "" : " No JsonStores."}
            </div>
            <div style={{ paddingTop: 20 }}>
                <b>ValStore:</b>
                {jsos?.valStore ? (
                    <li>{jsos?.valStore.constructor.name}</li>
                ) : (
                    " No ValStore."
                )}
            </div>
            <div style={{ paddingTop: 20 }}>
                <b>VarStore:</b>
                {jsos?.varStore ? (
                    <li>{jsos?.varStore.constructor.name}</li>
                ) : (
                    "No VarStore"
                )}
            </div>
            <div style={{ paddingTop: 20 }}>
                <b>Search For Var:</b>
                <div>
                    Name:{" "}
                    <input
                        onChange={(e) => {
                            setVarNameSearch(e.target.value);
                        }}
                    ></input>
                    <br />
                </div>
                <div>
                    Namespace:{" "}
                    <input
                        onChange={(e) => {
                            setVarNamespaceSearch(e.target.value);
                        }}
                    ></input>
                    <br />
                </div>
                <div style={{paddingTop: 10}}>
                    {foundVar ? (
                        <code>{JSON.stringify(foundVar, null, 2)}</code>
                    ) : (
                        <i>not found</i>
                    )}
                </div>
                {foundVar ? (
                    <button
                        onClick={() => {
                            (async () => {
                                if (
                                    await jsos?.deleteVar({
                                        name: varNameSearch,
                                        namespace: varNamespaceSearch,
                                    })
                                ) {
                                    setFoundVar(null);
                                }
                            })();
                        }}
                    >
                        delete ({varNameSearch}, {varNamespaceSearch || "null"})
                    </button>
                ) : (
                    <></>
                )}
            </div>
        </>
    );
}
