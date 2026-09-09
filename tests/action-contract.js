const fs = require("fs");
const path = require("path");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function runTest() {
  const baseDir = path.join(__dirname, "..");
  const htmlPath = path.join(baseDir, "index.html");
  const gsPath = path.join(baseDir, "Code.gs");
  
  const htmlContent = fs.readFileSync(htmlPath, "utf-8");
  const gsContent = fs.readFileSync(gsPath, "utf-8");
  
  // Extract actions from frontend
  const gasGetRegex = /gasGet\s*\(\s*['"]([^'"]+)['"]/g;
  const gasPostRegex = /gasPost\s*\(\s*['"]([^'"]+)['"]/g;
  const localRequestRegex = /localRequest\s*\(\s*['"]([^'"]+)['"]/g;
  
  const extractMatches = (regex, content) => {
    const matches = new Set();
    let match;
    while ((match = regex.exec(content)) !== null) {
      matches.add(match[1]);
    }
    return Array.from(matches);
  };
  
  const frontendGet = extractMatches(gasGetRegex, htmlContent);
  const frontendPost = extractMatches(gasPostRegex, htmlContent);
  const localOnly = extractMatches(localRequestRegex, htmlContent);
  
  // Extract actions from backend Code.gs
  const getFunctionBody = (funcName, content) => {
    const regex = new RegExp(`function\\s+${funcName}\\s*\\([^)]*\\)\\s*{`);
    const match = regex.exec(content);
    if (!match) return "";
    let braceCount = 1;
    let i = match.index + match[0].length;
    let bodyStart = i;
    while (i < content.length && braceCount > 0) {
      if (content[i] === '{') braceCount++;
      if (content[i] === '}') braceCount--;
      i++;
    }
    return content.substring(bodyStart, i - 1);
  };
  
  const dogetBody = getFunctionBody("doGet", gsContent);
  const doPostBody = getFunctionBody("doPost", gsContent);
  
  const actionRegex = /action\s*===\s*['"]([^'"]+)['"]/g;
  
  const backendGet = extractMatches(actionRegex, dogetBody);
  const backendPost = extractMatches(actionRegex, doPostBody);
  
  const mismatches = [];
  
  frontendGet.forEach(action => {
    if (!backendGet.includes(action)) {
      mismatches.push(`GET action '${action}' missing in doGet`);
    }
  });
  
  frontendPost.forEach(action => {
    if (!backendPost.includes(action)) {
      mismatches.push(`POST action '${action}' missing in doPost`);
    }
  });
  
  const results = {
    frontendGet: frontendGet.length,
    backendGet: backendGet.length,
    frontendPost: frontendPost.length,
    backendPost: backendPost.length,
    mismatches: mismatches,
    localOnly: localOnly
  };
  
  console.log(`action-contract=${JSON.stringify(results)}`);
  
  assert(mismatches.length === 0, "Action contract test failed: Mismatches found.\n" + mismatches.join("\n"));
}

runTest();
