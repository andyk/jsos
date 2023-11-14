import { JsosSession } from './jsos';
import * as fs from 'fs';
import * as path from 'path';

interface SyncVarParams {
    varName: string;
    varNamespace?: string;
    supabaseUrlEnvName?: string;
    supabaseKeyEnvName?: string;
}

function parseArgs(): SyncVarParams {
    const args = process.argv.slice(2);
    const params: Partial<SyncVarParams> = {};

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--supabase_url_env_name':
                params.supabaseUrlEnvName = args[i + 1];
                i++; // Skip the next item as it's part of this flag
                break;
            case '--supabase_key_env_name':
                params.supabaseKeyEnvName = args[i + 1];
                i++; // Skip the next item as it's part of this flag
                break;
            default:
                if (!params.varName) {
                    params.varName = args[i];
                } else if (params.varNamespace === undefined) {
                    // Treat "NULL" as undefined for varNamespace
                    params.varNamespace = args[i].toUpperCase() !== "NULL" ? args[i] : undefined;
                }
        }
    }

    if (!params.varName) {
        throw new Error('Missing required argument: varName');
    }

    return params as SyncVarParams;
}

async function syncVar(params: SyncVarParams): Promise<void> {
    const jsos = new JsosSession().addInMemory().addSupabaseFromEnv(params.supabaseUrlEnvName, params.supabaseKeyEnvName);

    let varWrapper = params.varNamespace ? (
        await jsos.getImmutableVar({ name: params.varName, namespace: params.varNamespace })
    ) : (
        await jsos.getImmutableVar({ name: params.varName })
    );

    if (!varWrapper) {
        console.log(`Var ${params.varName} does not exist in JSOS. Creating a new one.`);
        varWrapper = await jsos.newImmutableVar({ name: params.varName, namespace: params.varNamespace, val: {} });
    }

    const dirPath = path.join(__dirname, params.varNamespace || 'NULL');
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    let filePath = path.join(dirPath, `${params.varName}.json`);
    let counter = 1;

    while (fs.existsSync(filePath)) {
        filePath = path.join(dirPath, `${params.varName}_${counter}.json`);
        counter++;
    }

    fs.writeFileSync(filePath, JSON.stringify(varWrapper.__jsosVarObj, null, 2));
    console.log(`Var ${params.varName} has been synced to ${filePath}`);
}

const params = parseArgs();
syncVar(params)
    .then(() => console.log(`Var ${params.varName} synced successfully.`))
    .catch(error => console.error('Error syncing Var:', error));