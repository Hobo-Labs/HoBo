import { readFile } from "node:fs/promises";
import { join } from "node:path";

const contracts = [
  {
    package: "hobo:queue@0.1.0",
    interface: "queue",
    stability: "experimental",
    witPath: "wit/queue.wit"
  },
  {
    package: "hobo:scheduler@0.1.0",
    interface: "scheduler",
    stability: "experimental",
    witPath: "wit/scheduler.wit"
  },
  {
    package: "hobo:blob-events@0.1.0",
    interface: "blob-events",
    stability: "experimental",
    witPath: "wit/blob-events.wit"
  }
];

export async function getContractCatalog(root) {
  const catalog = [];

  for (const contract of contracts) {
    const wit = await readFile(join(root, contract.witPath), "utf8");
    assertContains(wit, `package ${contract.package};`);
    assertContains(wit, `interface ${contract.interface} {`);
    assertContains(wit, `/// stability: ${contract.stability}`);
    catalog.push({ ...contract });
  }

  return catalog;
}

export function parseWitFunctions(wit, interfaceName) {
  const body = extractBlock(wit, `interface ${interfaceName}`);
  return new Set([...body.matchAll(/^\s*([%a-zA-Z0-9-]+):\s*func\b/gm)].map((match) => match[1]));
}

export function requireFunction(functions, name) {
  assert(functions.has(name), `missing WIT function ${name}`);
}

export function requireRecordField(wit, recordName, fieldName) {
  const body = extractBlock(wit, `record ${recordName}`);
  assert(
    new RegExp(`^\\s*${escapeRegExp(fieldName)}\\s*:`, "m").test(body),
    `missing field ${recordName}.${fieldName}`
  );
}

function extractBlock(wit, prefix) {
  const start = wit.indexOf(`${prefix} {`);
  assert(start >= 0, `missing WIT block ${prefix}`);

  const open = wit.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < wit.length; index += 1) {
    if (wit[index] === "{") {
      depth += 1;
    } else if (wit[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return wit.slice(open + 1, index);
      }
    }
  }

  throw new Error(`unterminated WIT block ${prefix}`);
}

function assertContains(text, expected) {
  assert(text.includes(expected), `missing ${expected}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
