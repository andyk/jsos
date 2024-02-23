import { JsosSession } from "./jsos";
import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { List as ImmutableList } from "immutable";
import { createClient } from "@supabase/supabase-js";

const supa = createClient(process.env["SUPABASE_URL_HEADLONG"], process.env["SUPABASE_SERVICE_ROLE_KEY_HEADLONG"])

interface SyncVarParams {
  varName: string;
  varNamespace?: string;
  supabaseUrlEnvName?: string;
  supabaseKeyEnvName?: string;
  inputFile?: string;
  outputFile?: string;
  shareGptFormat?: boolean; // if false, use ChatGPT format
  newVarName?: string;
}

const params = {
  varName: "headlong",
  varNamespace: "headlong-vite-v2",
  supabaseUrlEnvName: "SUPABASE_URL_HEADLONG",
  supabaseKeyEnvName: "SUPABASE_SERVICE_ROLE_KEY_HEADLONG",
};

export async function getHeadlongVar() {
  const jsos = new JsosSession().addInMemory().addSupabaseFromEnv(params.supabaseUrlEnvName, params.supabaseKeyEnvName);

  const headlong: any = params.varNamespace
    ? await jsos.getImmutableVar({ name: params.varName, namespace: params.varNamespace })
    : await jsos.getImmutableVar({ name: params.varName });

  if (!headlong) {
    console.log(`Var ${params.varName} does not exist in JSOS. Exiting`);
    return;
  }
  return headlong;
}

export async function syncHeadlongVarToJsonl(): Promise<void> {
  const headlong = await getHeadlongVar();
  const dirPath = path.join(__dirname, "headlong-v2-agents");
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  console.log("AGENT: ", headlong.agents.map((agent) => agent));

  headlong.agents.forEach((agent: any, name: string) => {
    console.log("agent:", JSON.stringify(agent));
    const filePath = path.join(dirPath, `${name}.jsonl`);
    fs.writeFileSync(
      filePath,
      agent.thoughts.map(([thought]: [any]) => `{content="${JSON.stringify(thought.body)}"}`).join("\n")
    );
    //console.log(`Var ${params.varName} has been synced to ${filePath}`);
  });
}

export async function syncHeadlongAgentsToJson(): Promise<void> {
    const headlong = await getHeadlongVar();
    const filePath = path.join('agents.jsonl');
    fs.writeFileSync(
        filePath,
        JSON.stringify(
            headlong.agents.toList().map((agent) => agent.thoughts.map(([thought]: [any]) => thought.body)).toArray()
        )
    );
}

//export async function pushToHeadlongReboot(): Promise<void> {
//    const headlong = await getHeadlongVar();
//  
//    headlong.agents.forEach(async (agent: any, name: string) => {
//      agent.thoughts.map(async ([thought]: [any]) => {
//          // Convert Date to UNIX timestamp (milliseconds)
//          const timestampAsInt = thought.timestamp?.getTime() || 0;
//  
//          // If you prefer seconds, you can convert like this:
//          // const timestampInSeconds = Math.floor(thought.timestamp.getTime() / 1000);
//  
//          // Or using bitwise OR to truncate decimals (effectively flooring):
//          // const timestampInSeconds = thought.timestamp.getTime() / 1000 | 0;
//  
//          const { data, error } = await supa.from('thoughts_test_bilbo_import').insert({
//              agent_name: name,
//              body: thought.body,
//              index: timestampAsInt // or timestampInSeconds if you're using the seconds version
//          });
//          if (error) {
//              console.error('Error inserting thought:', error);
//          }
//          if (data) {
//              console.log('Inserted thought:', data);
//          }
//      });
//    });
//}

export async function pushToHeadlongReboot(): Promise<void> {
    const headlong = await getHeadlongVar();
  
    // Assuming headlong.agents is an OrderedMap
    headlong.agents.forEach(async (agent: any, name: string) => {
      // Initialize the thought index counter for each agent
      let thoughtIndex = 1;

      // Assuming agent.thoughts is a List
      agent.thoughts.forEach(async ([thought]: any) => {
          // Use the thoughtIndex as the index for each thought
          const { data, error } = await supa.from('thoughts').insert({
              agent_name: name,
              body: thought.body,
              index: thoughtIndex++
          });
          
          if (error) {
              console.error('Error inserting thought:', error);
          }
          if (data) {
              console.log('Inserted thought:', data);
          }
      });
    });
}

//syncHeadlongVarToJson()
//    .then(() => console.log(`Var ${params.varName} written to file successfully.`))
//    .catch(error => console.error('Error writing file from headlong-vite-v2/headlong var:', error));

function readAgentsFromFile(filename: string): string[][] {
  try {
    const data = fs.readFileSync(filename, "utf-8");
    const sections = data.split(/\n\n/); // Split the file content by double new line
    const splitSections = sections.map((section) => section.split(/\r?\n/));
    console.log("splitSections: ", splitSections);
    return splitSections.filter((val, idx) => val.length > 0); // Split each section by new line
  } catch (error) {
    console.error(`Error reading file: ${error}`);
    process.exit(1);
  }
}

export async function mergeAgentsFromFile(params: SyncVarParams) {
  if (params.inputFile === undefined) {
    console.log("Please provide a filename as an argument.");
    process.exit(1);
  }

  const sections = readAgentsFromFile(params.inputFile);

  //Load the existing headlong Var
  const jsos = new JsosSession().addInMemory().addSupabaseFromEnv(params.supabaseUrlEnvName, params.supabaseKeyEnvName);
  let headlong: any = params.varNamespace
    ? await jsos.getVar({ name: params.varName, namespace: params.varNamespace })
    : await jsos.getVar({ name: params.varName });
  const valObj = headlong.__jsosVarObj;
  sections.forEach(async (section) => {
    const agentName = uuidv4();
    valObj.agents = headlong.agents.set(agentName, { name: agentName, thoughts: ImmutableList() });
    section.forEach(async (line) => {
      valObj.agents = valObj.agents.updateIn([agentName, "thoughts"], (old: any) =>
        old.push([
          {
            timestamp: new Date(),
            body: line,
            context: {},
            open_ai_embedding: [],
          },
          [],
        ])
      );
    });
  });
  console.log(
    "done loading thoughts. Num thoughts: ",
    valObj.agents.map((agent: any, name: string) => agent.thoughts.size).reduce((r: any, v: any, k: any) => r + v, 0)
  );

  const filePath = path.join(params.outputFile ?? "headlong-v2-agents.jsonl");
  const messages = valObj.agents.map((agent: any, name: string) => {
    if (params.shareGptFormat) {
      return { conversations: agent.thoughts.map(([thought]: [any]) => ({ from: "gpt", value: thought.body })) };
    } else {
      return { messages: agent.thoughts.map(([thought]: [any]) => ({ role: "assistant", content: thought.body })) };
    }
  });

  messages.forEach((message: any) => {
    fs.appendFileSync(filePath, JSON.stringify(message) + "\n");
  });

  if (params.newVarName !== undefined) {
    const newVarObj = await jsos.newVar({
      name: params.newVarName,
      namespace: params.varNamespace ?? "headlong-vite-v2",
      val: valObj,
    });
    console.log(`Var ${params.newVarName} has been synced to JSOS.`);
  }
}

export async function mergeNewAgentsIntoHeadlongVar() {
  const params = {
    varName: "headlong",
    varNamespace: "headlong-vite-v2",
    supabaseUrlEnvName: "SUPABASE_URL_HEADLONG",
    supabaseKeyEnvName: "SUPABASE_SERVICE_ROLE_KEY_HEADLONG",
    inputFile: "newAgents.txt",
    outputFile: "headlong-v2-agents.jsonl",
    shareGptFormat: true,
    newVarName: "headlong-merged",
  };

  mergeAgentsFromFile(params);
}

function readFileSections(filename: string): string[][] {
  try {
    const data = fs.readFileSync(filename, "utf-8");
    const sections = data.split(/\n\n/); // Split the file content by double new line
    const splitSections = sections.map((section) => section.split(/\r?\n/));
    console.log("splitSections: ", splitSections);
    return splitSections.filter((val, idx) => val.length > 0); // Split each section by new line
  } catch (error) {
    console.error(`Error reading file: ${error}`);
    process.exit(1);
  }
}

export async function writeThoughtsToFile(params: SyncVarParams) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Please provide a filename as an argument.");
    process.exit(1);
  }

  const filename = args[0];
  const sections = readFileSections(filename);

  //Load the existing headlong Var
  const jsos = new JsosSession().addInMemory().addSupabaseFromEnv(params.supabaseUrlEnvName, params.supabaseKeyEnvName);
  let headlong: any = params.varNamespace
    ? await jsos.getVar({ name: params.varName, namespace: params.varNamespace })
    : await jsos.getVar({ name: params.varName });
  const valObj = headlong.__jsosVarObj;
  sections.forEach(async (section) => {
    const agentName = uuidv4();
    valObj.agents = headlong.agents.set(agentName, { name: agentName, thoughts: ImmutableList() });
    section.forEach(async (line) => {
      valObj.agents = valObj.agents.updateIn([agentName, "thoughts"], (old: any) =>
        old.push([
          {
            timestamp: new Date(),
            body: line,
            context: {},
            open_ai_embedding: [],
          },
          [],
        ])
      );
    });
  });
  console.log(
    "done loading thoughts. Num thoughts: ",
    valObj.agents.map((agent: any, name: string) => agent.thoughts.size).reduce((r: any, v: any, k: any) => r + v, 0)
  );

  const filePath = path.join(params.outputFile ?? "headlong-v2-agents.jsonl");
  const messages = valObj.agents.map((agent: any, name: string) => {
    if (params.shareGptFormat) {
      return { conversations: agent.thoughts.map(([thought]: [any]) => ({ from: "gpt", value: thought.body })) };
    } else {
      return { messages: agent.thoughts.map(([thought]: [any]) => ({ role: "assistant", content: thought.body })) };
    }
  });

  messages.forEach((message: any) => {
    fs.appendFileSync(filePath, JSON.stringify(message) + "\n");
  });

  if (params.newVarName !== undefined) {
    const newVarObj = await jsos.newVar({
      name: params.newVarName,
      namespace: params.varNamespace ?? "headlong-vite-v2",
      val: valObj,
    });
    console.log(`Var ${params.newVarName} has been synced to JSOS.`);
  }
}

export async function writeHeadlongThoughtsToFile() {
  const params = {
    varName: "headlong",
    varNamespace: "headlong-vite-v2",
    supabaseUrlEnvName: "SUPABASE_URL_HEADLONG",
    supabaseKeyEnvName: "SUPABASE_SERVICE_ROLE_KEY_HEADLONG",
    outputFile: "headlong-v2-agents.jsonl",
    shareGptFormat: true,
    newVarName: "headlong-merged",
  };

  writeThoughtsToFile(params);
}

export async function writeVarToFile(params: SyncVarParams): Promise<void> {
  const jsos = new JsosSession().addInMemory().addSupabaseFromEnv(params.supabaseUrlEnvName, params.supabaseKeyEnvName);

  let varWrapper = params.varNamespace
    ? await jsos.getImmutableVar({ name: params.varName, namespace: params.varNamespace })
    : await jsos.getImmutableVar({ name: params.varName });

  if (!varWrapper) {
    console.log(`Var ${params.varName} does not exist in JSOS. Creating a new one.`);
    varWrapper = await jsos.newImmutableVar({ name: params.varName, namespace: params.varNamespace, val: {} });
  }

  const dirPath = path.join(__dirname, params.varNamespace || "NULL");
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

function main() {
  const commandKey = process.argv[1];
  const args = process.argv.slice(2);
  const params: Partial<SyncVarParams> = {};

  if (commandKey === "pull") {
    for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
        case "--supabase_url_env_name":
          params.supabaseUrlEnvName = args[i + 1];
          i++; // Skip the next item as it's part of this flag
          break;
        case "--supabase_key_env_name":
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
      throw new Error("Missing required argument: varName");
    }

    writeVarToFile(params as SyncVarParams);
  }
}

main();
