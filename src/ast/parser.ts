/**
 * memnant — AST-anchored structural hashing via web-tree-sitter.
 *
 * Parses source files using WASM-compiled Tree-sitter grammars, locates
 * named symbols (functions, classes, methods), and computes structural
 * hashes that are immune to formatting and comment changes.
 *
 * Grammars are lazy-loaded: downloaded from CDN on first use for a given
 * language, then cached at ~/.memnant/grammars/ for offline reuse.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, extname } from 'path';
import { homedir } from 'os';
import type TSParser from 'web-tree-sitter';

// Re-exported types from web-tree-sitter
type Parser = TSParser.Parser;
type Language = TSParser.Language;
type SyntaxNode = TSParser.Node;

/** Supported languages and their file extensions */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.rb': 'ruby',
};

/** CDN base URL for tree-sitter WASM grammar files */
const GRAMMAR_CDN_BASE = 'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.0.11/out';

/** Local grammar cache directory */
function getGrammarCacheDir(): string {
  return join(homedir(), '.memnant', 'grammars');
}

/**
 * Node types that represent named declarations across languages.
 * Used by findSymbolNode to locate symbols in the AST.
 */
const DECLARATION_NODE_TYPES = [
  // JavaScript / TypeScript
  'function_declaration',
  'class_declaration',
  'method_definition',
  'variable_declarator',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  // Python
  'function_definition',
  'class_definition',
  // Go
  'function_declaration',
  'method_declaration',
  'type_declaration',
  'type_spec',
  // Rust
  'function_item',
  'struct_item',
  'enum_item',
  'impl_item',
  'trait_item',
  // Java
  'class_declaration',
  'method_declaration',
  'interface_declaration',
  // Ruby
  'method',
  'class',
  'module',
];

// Comment node types across languages
const COMMENT_NODE_TYPES = new Set([
  'comment',
  'line_comment',
  'block_comment',
  'doc_comment',
]);

// Lazy-loaded state
let ParserCtor: typeof TSParser.Parser | null = null;
let LanguageCtor: typeof TSParser.Language | null = null;
let parserInstance: Parser | null = null;
const loadedLanguages = new Map<string, Language>();

/**
 * Initialise the Tree-sitter WASM parser. Lazy-loaded on first use.
 */
async function initParser(): Promise<Parser> {
  if (parserInstance) return parserInstance;

  const mod = await import('web-tree-sitter');
  const P = mod.Parser;
  await P.init();
  ParserCtor = P;
  LanguageCtor = mod.Language;
  parserInstance = new P();
  return parserInstance;
}

/**
 * Detect language from file extension.
 * Returns null for unsupported languages.
 */
export function detectLanguage(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

/**
 * Get the list of supported file extensions.
 */
export function getSupportedExtensions(): string[] {
  return Object.keys(EXTENSION_TO_LANGUAGE);
}

/**
 * Download a WASM grammar file from CDN to the local cache.
 * Returns the local file path, or null if download failed.
 */
async function downloadGrammar(language: string): Promise<string | null> {
  const cacheDir = getGrammarCacheDir();
  const localPath = join(cacheDir, `tree-sitter-${language}.wasm`);

  if (existsSync(localPath)) return localPath;

  mkdirSync(cacheDir, { recursive: true });

  const url = `${GRAMMAR_CDN_BASE}/tree-sitter-${language}.wasm`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      process.stderr.write(`[memnant] Failed to download grammar for ${language}: HTTP ${response.status}\n`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(localPath, buffer);
    process.stderr.write(`[memnant] Downloaded grammar: tree-sitter-${language}.wasm (${Math.round(buffer.length / 1024)} KB)\n`);
    return localPath;
  } catch (err) {
    process.stderr.write(`[memnant] Grammar download failed for ${language}: ${err}\n`);
    return null;
  }
}

/**
 * Load a language grammar, downloading it if necessary.
 * Returns null if the language is unsupported or download fails.
 */
async function ensureLanguage(language: string): Promise<Language | null> {
  if (loadedLanguages.has(language)) return loadedLanguages.get(language)!;

  if (!LanguageCtor) await initParser();

  const grammarPath = await downloadGrammar(language);
  if (!grammarPath) return null;

  try {
    const lang = await LanguageCtor!.load(grammarPath);
    loadedLanguages.set(language, lang);
    return lang;
  } catch (err) {
    process.stderr.write(`[memnant] Failed to load grammar for ${language}: ${err}\n`);
    return null;
  }
}

/**
 * Parse source code and return the syntax tree's root node.
 * Returns null if parsing fails or language is unsupported.
 */
export async function parseSource(
  source: string,
  language: string,
): Promise<SyntaxNode | null> {
  const parser = await initParser();
  const lang = await ensureLanguage(language);
  if (!lang) return null;

  parser.setLanguage(lang);
  const tree = parser.parse(source);
  if (!tree) return null;

  return tree.rootNode;
}

/**
 * Find a named symbol (function, class, method, etc.) in the AST.
 * Walks the tree looking for declaration nodes whose name matches.
 * Returns the declaration node, or null if not found.
 */
export function findSymbolNode(
  rootNode: SyntaxNode,
  symbolName: string,
): SyntaxNode | null {
  // BFS through the tree to find the symbol
  const queue: SyntaxNode[] = [rootNode];

  while (queue.length > 0) {
    const node = queue.shift()!;

    if (isDeclarationWithName(node, symbolName)) {
      return node;
    }

    // Add children to queue
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) queue.push(child);
    }
  }

  return null;
}

/**
 * Check if a node is a named declaration that matches the given symbol name.
 */
function isDeclarationWithName(node: SyntaxNode, symbolName: string): boolean {
  const nodeType = node.type;

  // Check if this is a declaration type
  if (!DECLARATION_NODE_TYPES.includes(nodeType)) return false;

  // Try to find the name via the 'name' field
  const nameNode = node.childForFieldName('name');
  if (nameNode && nameNode.text === symbolName) return true;

  // For variable_declarator, the name is in the 'name' field
  if (nodeType === 'variable_declarator') {
    const varName = node.childForFieldName('name');
    if (varName && varName.text === symbolName) return true;
  }

  // For type_spec in Go, the name is in the 'name' field
  if (nodeType === 'type_spec') {
    const typeName = node.childForFieldName('name');
    if (typeName && typeName.text === symbolName) return true;
  }

  return false;
}

/**
 * Compute a structural hash for an AST node.
 *
 * Traverses the node, ignoring comments and whitespace.
 * For leaf nodes, appends type:text. For structural nodes, appends type.
 * The resulting string is SHA256-hashed.
 *
 * This hash is stable across:
 * - Formatting changes (indentation, blank lines)
 * - Comment changes (added, removed, modified)
 * - Whitespace changes
 *
 * This hash changes when:
 * - Variable names change
 * - Logic changes (new statements, different operators)
 * - Type annotations change
 * - Parameters change
 */
export function computeStructuralHash(node: SyntaxNode): string {
  let hashString = '';

  const traverse = (n: SyntaxNode): void => {
    // Skip comments entirely
    if (COMMENT_NODE_TYPES.has(n.type) || n.isExtra) return;

    if (n.childCount === 0) {
      // Leaf node — include type and text
      hashString += `${n.type}:${n.text}|`;
    } else {
      // Structural node — include type only
      hashString += `${n.type}|`;
      for (let i = 0; i < n.childCount; i++) {
        const child = n.child(i);
        if (child) traverse(child);
      }
    }
  };

  traverse(node);

  return createHash('sha256').update(hashString).digest('hex');
}

/**
 * High-level API: compute the AST structural hash for a symbol in a file.
 *
 * @param filePath - Absolute path to the source file
 * @param symbolName - Name of the symbol to hash, or 'global' for the entire file
 * @returns The structural hash, or null if parsing/lookup fails
 */
export async function computeAstHash(
  filePath: string,
  symbolName: string,
): Promise<string | null> {
  if (!existsSync(filePath)) return null;

  const ext = extname(filePath).toLowerCase();
  const language = EXTENSION_TO_LANGUAGE[ext];
  if (!language) return null;

  const source = readFileSync(filePath, 'utf-8');
  return computeAstHashFromSource(source, symbolName, language);
}

/**
 * Compute AST hash from source code string (useful for testing).
 *
 * @param source - Source code string
 * @param symbolName - Symbol to hash, or 'global' for entire file
 * @param language - Tree-sitter language name
 * @returns The structural hash, or null if parsing/lookup fails
 */
export async function computeAstHashFromSource(
  source: string,
  symbolName: string,
  language: string,
): Promise<string | null> {
  const rootNode = await parseSource(source, language);
  if (!rootNode) return null;

  if (symbolName === 'global') {
    return computeStructuralHash(rootNode);
  }

  const symbolNode = findSymbolNode(rootNode, symbolName);
  if (!symbolNode) return null;

  return computeStructuralHash(symbolNode);
}

/**
 * Compute AST hash for a symbol in a file, resolving relative paths
 * against the project root.
 *
 * @param targetFile - Relative file path (from project root)
 * @param symbolName - Symbol to hash, or 'global' for entire file
 * @param projectRoot - Project root directory
 * @returns The structural hash, or null if unavailable
 */
export async function computeAstHashForRecord(
  targetFile: string,
  symbolName: string,
  projectRoot: string,
): Promise<string | null> {
  const absPath = join(projectRoot, targetFile);
  return computeAstHash(absPath, symbolName);
}
