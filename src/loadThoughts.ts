import { JsosSession } from './jsos'
import { readFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { List as ImmutableList } from "immutable";
import * as fs from 'fs';
import * as path from 'path';

interface SyncVarParams {
    varName: string;
    varNamespace?: string;
    supabaseUrlEnvName?: string;
    supabaseKeyEnvName?: string;
    outputFile?: string;
    shareGptFormat?: boolean; // if false, use ChatGPT format
    newVarName?: string;
}

function readFileSections(filename: string): string[][] {
    try {
        const data = readFileSync(filename, 'utf-8');
        const sections = data.split(/\n\n/); // Split the file content by double new line
        const splitSections = sections.map(section => section.split(/\r?\n/));
        console.log("splitSections: ", splitSections)
        return splitSections.filter((val, idx) => val.length > 0); // Split each section by new line
    } catch (error) {
        console.error(`Error reading file: ${error}`);
        process.exit(1);
    }
}

async function main(params: SyncVarParams) {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.log('Please provide a filename as an argument.');
        process.exit(1);
    }

    const filename = args[0];
    const sections = readFileSections(filename);

    //Load the existing headlong Var
    const jsos = new JsosSession().addInMemory().addSupabaseFromEnv(params.supabaseUrlEnvName, params.supabaseKeyEnvName);
    let headlong: any = params.varNamespace ? (
        await jsos.getVar({ name: params.varName, namespace: params.varNamespace })
    ) : (
        await jsos.getVar({ name: params.varName })
    );
    const valObj = headlong.__jsosVarObj
    sections.forEach(async section => {
        const agentName = uuidv4();
        valObj.agents = headlong.agents.set(agentName, ({ name: agentName, thoughts: ImmutableList() }));
        section.forEach(async line => {
            valObj.agents = valObj.agents.updateIn(
                [agentName, "thoughts"],
                (old: any) => old.push(
                    [
                        {
                            "timestamp": new Date(),
                            "body": line,
                            "context": {},
                            "open_ai_embedding": []
                        },
                        []
                    ]
                ));
        })
    });
    console.log("done loading thoughts. Num thoughts: ", valObj.agents.map((agent: any, name: string) => agent.thoughts.size).reduce((r: any, v: any, k: any) => r + v, 0));

    const filePath = path.join(params.outputFile ?? "headlong-v2-agents.jsonl");
    const messages =  valObj.agents.map((agent: any, name: string) => {
        if (params.shareGptFormat) {
            return { conversations: agent.thoughts.map(([thought]: [any]) => ({ from: "gpt", value: thought.body })) }
        } else {
            return { messages: agent.thoughts.map(([thought]: [any]) => ({ role: "assistant", content: thought.body })) }
        } 
    })

    messages.forEach((message: any) => {
        fs.appendFileSync(filePath, JSON.stringify(message) + "\n");
    });

    if (params.newVarName !== undefined) {
        const newVarObj = await jsos.newVar(
            {
                name: params.newVarName,
                namespace: params.varNamespace ?? "headlong-vite-v2",
                val: valObj
            });
        console.log(`Var ${params.newVarName} has been synced to JSOS.`);
    }
}

const params = {
    varName: 'headlong',
    varNamespace: 'headlong-vite-v2',
    supabaseUrlEnvName: 'SUPABASE_URL_HEADLONG',
    supabaseKeyEnvName: 'SUPABASE_SERVICE_ROLE_KEY_HEADLONG',
    outputFile: 'headlong-v2-agents.jsonl',
    shareGptFormat: true,
    newVarName: 'headlong-merged',
};

main(params);
