import React, { useEffect } from 'react';
import jsos, { Variable, Value } from './jsos';

export const DataContext = React.createContext<Array<Value|Function|null>>([]);

export default function JsosContextProvider({ children, name, namespace }) {
    const [jsosVar, setJsosVar] = React.useState<null | Variable >(null);
    const [appData, setAppData] = React.useState<{[key: string]: null | Value}>({ pObject: null });

    function varChanged(newObj, newSha1) {
        console.log("varChanged triggered: ", newObj, newSha1)
        setAppData({ pObject: newObj })
    }
    useEffect(() => {
        (async () => {
            let fetchedVar = await jsos.variable('appData', "benw-trivia", true, varChanged);
            setJsosVar(fetchedVar);
            console.log("finished init setAppData to: ", fetchedVar);
        })();
    }, []);

    useEffect(() => {
        console.log("jsosVar changed: ", jsosVar);
        (async () => {
            let pObj = jsosVar === null ? null : await jsosVar.get();
            console.log("jsosVar update triggered: setting pObj: ", pObj);
            setAppData({ pObject: pObj });
        })();
    }, [jsosVar]);

    async function updatePObject(updateFun) {
        if (jsosVar !== null) {
            const newPObj = await jsosVar.update(updateFun);
            setAppData({ pObject: newPObj });
        }
    }

    return (
        <DataContext.Provider value={[appData.pObject, updatePObject]}>
            {children}
        </DataContext.Provider>
    );
}