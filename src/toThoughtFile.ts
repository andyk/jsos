import { JsosSession } from './jsos'
import * as fs from 'fs';
import * as path from 'path';

interface SyncVarParams {
    varName: string;
    varNamespace?: string;
    supabaseUrlEnvName?: string;
    supabaseKeyEnvName?: string;
}

async function syncVar(params: SyncVarParams): Promise<void> {
    const jsos = new JsosSession().addInMemory().addSupabaseFromEnv(params.supabaseUrlEnvName, params.supabaseKeyEnvName);

    const headlong: any = params.varNamespace ? (
        await jsos.getImmutableVar({ name: params.varName, namespace: params.varNamespace })
    ) : (
        await jsos.getImmutableVar({ name: params.varName })
    );

    if (!headlong) {
        console.log(`Var ${params.varName} does not exist in JSOS. Exiting`);
        return;
    }

    const dirPath = path.join(__dirname, 'headlong-v2-agents');
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    headlong.agents.forEach((agent: any, name: string) => { 
        console.log("agent:", JSON.stringify(agent));
        const filePath = path.join(dirPath, `${name}.json`);
        fs.writeFileSync(filePath, agent.thoughts.map(([thought]: [any]) => thought.body).join('\n'));
        console.log(`Var ${params.varName} has been synced to ${filePath}`);
    })
}

const params = {
    varName: 'headlong',
    varNamespace: 'headlong-vite-v2',
    supabaseUrlEnvName: 'SUPABASE_URL_HEADLONG',
    supabaseKeyEnvName: 'SUPABASE_SERVICE_ROLE_KEY_HEADLONG'
};
syncVar(params)
    .then(() => console.log(`Var ${params.varName} written to file successfully.`))
    .catch(error => console.error('Error writing file from headlong-vite-v2/headlong var:', error));