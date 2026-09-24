import type { ParsedFile, Scope, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { StructuralImplementationResult } from '../../scope-resolution/contract/scope-resolver.js';
import { findShapeBindingInScope, lookupBindingsAt } from '../../scope-resolution/scope/walkers.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

interface AssertedThisType {
  readonly line: number;
  readonly column: number;
  readonly typeName: string;
}

interface TypeScriptReceiverImplementationSideChannel {
  readonly kind: 'typescript-receiver-implementations';
  readonly assertions: readonly AssertedThisType[];
}

const assertionsByFile = new Map<string, AssertedThisType[]>();

const THIS_BINDING_FUNCTIONS = new Set([
  'function_expression',
  'function_declaration',
  'generator_function',
  'generator_function_declaration',
]);

function unwrapParentheses(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (current.type === 'parenthesized_expression') {
    const expression = current.childForFieldName('expression') ?? current.namedChild(0);
    if (expression === null) break;
    current = expression;
  }
  return current;
}

function isNestedAsExpression(node: SyntaxNode): boolean {
  let wrapped = node;
  while (wrapped.parent?.type === 'parenthesized_expression') wrapped = wrapped.parent;
  const parent = wrapped.parent;
  return parent?.type === 'as_expression' && parent.childForFieldName('expression') === wrapped;
}

function normalizeNamedType(raw: string): string | undefined {
  const normalized = raw.trim().replace(/\s*\.\s*/g, '.');
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/.test(normalized) ? normalized : undefined;
}

function instanceClassForThis(node: SyntaxNode): SyntaxNode | undefined {
  let current = node.parent;
  while (current !== null) {
    if (THIS_BINDING_FUNCTIONS.has(current.type)) return undefined;

    if (current.type === 'method_definition') {
      const classBody = current.parent;
      const owner = classBody?.type === 'class_body' ? classBody.parent : null;
      if (
        owner === null ||
        (owner.type !== 'class_declaration' &&
          owner.type !== 'abstract_class_declaration' &&
          owner.type !== 'class')
      ) {
        return undefined;
      }
      if (owner.type === 'abstract_class_declaration') return undefined;

      for (let index = 0; index < current.childCount; index++) {
        if (current.child(index)?.type === 'static') return undefined;
      }
      return owner;
    }

    current = current.parent;
  }
  return undefined;
}

/**
 * Capture only explicit instance-receiver assertions such as
 * `return this as unknown as module.Host`. This is deliberately narrower than
 * name-based structural matching: the source itself must connect the concrete
 * class's `this` to the object-type alias.
 */
export function captureTypeScriptReceiverAssertions(filePath: string, root: SyntaxNode): void {
  const captured: AssertedThisType[] = [];
  const stack: SyntaxNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'as_expression' && !isNestedAsExpression(node)) {
      let expression = unwrapParentheses(node);
      let assertedType: SyntaxNode | null = null;
      while (expression.type === 'as_expression') {
        const typeNode = expression.childForFieldName('type');
        if (assertedType === null && typeNode !== null) assertedType = typeNode;
        const inner = expression.childForFieldName('expression');
        if (inner === null) break;
        expression = unwrapParentheses(inner);
      }

      const owner = expression.type === 'this' ? instanceClassForThis(expression) : undefined;
      const typeName = assertedType === null ? undefined : normalizeNamedType(assertedType.text);
      if (owner !== undefined && typeName !== undefined) {
        captured.push({
          line: expression.startPosition.row + 1,
          column: expression.startPosition.column,
          typeName,
        });
      }
    }

    for (let index = node.namedChildCount - 1; index >= 0; index--) {
      const child = node.namedChild(index);
      if (child !== null) stack.push(child);
    }
  }

  if (captured.length === 0) return;
  const existing = assertionsByFile.get(filePath);
  assertionsByFile.set(filePath, existing === undefined ? captured : [...existing, ...captured]);
}

/** Called immediately after TypeScript scope capture in the parse worker. */
export function collectTypeScriptReceiverImplementationSideChannel(
  filePath: string,
): TypeScriptReceiverImplementationSideChannel | undefined {
  const assertions = assertionsByFile.get(filePath);
  assertionsByFile.delete(filePath);
  return assertions === undefined || assertions.length === 0
    ? undefined
    : { kind: 'typescript-receiver-implementations', assertions };
}

function containsPosition(
  scope: Scope,
  position: Pick<AssertedThisType, 'line' | 'column'>,
): boolean {
  const afterStart =
    position.line > scope.range.startLine ||
    (position.line === scope.range.startLine && position.column >= scope.range.startCol);
  const beforeEnd =
    position.line < scope.range.endLine ||
    (position.line === scope.range.endLine && position.column <= scope.range.endCol);
  return afterStart && beforeEnd;
}

function rangeSpan(scope: Scope): number {
  return (
    (scope.range.endLine - scope.range.startLine) * 1_000_000 +
    (scope.range.endCol - scope.range.startCol)
  );
}

function smallestContainingScope(
  parsed: ParsedFile,
  position: Pick<AssertedThisType, 'line' | 'column'>,
): Scope | undefined {
  let best: Scope | undefined;
  for (const scope of parsed.scopes) {
    if (!containsPosition(scope, position)) continue;
    if (best === undefined || rangeSpan(scope) < rangeSpan(best)) best = scope;
  }
  return best;
}

function classAtPosition(
  parsed: ParsedFile,
  position: Pick<AssertedThisType, 'line' | 'column'>,
): SymbolDefinition | undefined {
  let bestScope: Scope | undefined;
  let bestClass: SymbolDefinition | undefined;
  let ambiguous = false;
  for (const scope of parsed.scopes) {
    if (scope.kind !== 'Class' || !containsPosition(scope, position)) continue;
    const classes = scope.ownedDefs.filter((def) => def.type === 'Class');
    if (classes.length !== 1) continue;
    if (bestScope === undefined || rangeSpan(scope) < rangeSpan(bestScope)) {
      bestScope = scope;
      bestClass = classes[0];
      ambiguous = false;
    } else if (rangeSpan(scope) === rangeSpan(bestScope)) {
      ambiguous = true;
    }
  }
  return ambiguous ? undefined : bestClass;
}

function namespaceShadowed(
  scope: Scope | undefined,
  namespaceName: string,
  indexes: ScopeResolutionIndexes,
): boolean {
  let current = scope;
  while (current !== undefined) {
    // Namespace imports have their own origin; a local binding at any level
    // shadows them. `lexicalNames` also catches untyped parameters with no def.
    if (current.bindings.get(namespaceName)?.some((binding) => binding.origin === 'local')) {
      return true;
    }
    if (current.lexicalNames?.has(namespaceName)) return true;
    current = current.parent === null ? undefined : indexes.scopeTree.getParent(current.id);
  }
  return false;
}

function objectTypeAliasIds(parsedFiles: readonly ParsedFile[]): Set<string> {
  const ids = new Set<string>();
  for (const parsed of parsedFiles) {
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Class') continue;
      for (const def of scope.ownedDefs) {
        if (def.type === 'TypeAlias') ids.add(def.nodeId);
      }
    }
  }
  return ids;
}

function resolveAssertedObjectTypeAlias(
  parsed: ParsedFile,
  scope: Scope | undefined,
  scopeId: string,
  rawTypeName: string,
  indexes: ScopeResolutionIndexes,
  objectAliases: ReadonlySet<string>,
): SymbolDefinition | undefined {
  const typeName = normalizeNamedType(rawTypeName);
  if (typeName === undefined) return undefined;
  const parts = typeName.split('.');

  if (parts.length === 1) {
    const resolved = findShapeBindingInScope(scopeId, parts[0]!, indexes);
    return resolved?.type === 'TypeAlias' && objectAliases.has(resolved.nodeId)
      ? resolved
      : undefined;
  }

  const [namespaceName, exportedName] = parts as [string, string];
  if (namespaceShadowed(scope, namespaceName, indexes)) return undefined;
  const namespaceEdges = (indexes.imports.get(parsed.moduleScope) ?? []).filter(
    (edge) =>
      edge.kind === 'namespace' &&
      edge.localName === namespaceName &&
      edge.targetModuleScope !== undefined,
  );
  if (namespaceEdges.length !== 1) return undefined;

  const targetScope = namespaceEdges[0]!.targetModuleScope!;
  const bindings = lookupBindingsAt(targetScope, exportedName, indexes);
  const definitions = new Map(bindings.map((binding) => [binding.def.nodeId, binding.def]));
  if (definitions.size !== 1) return undefined;
  const resolved = [...definitions.values()][0];
  return resolved?.type === 'TypeAlias' &&
    resolved.isExported === true &&
    objectAliases.has(resolved.nodeId)
    ? resolved
    : undefined;
}

/**
 * Materialize receiver-dispatch candidates from explicit `this` assertions.
 * No other class/alias pair is inferred, and only object-type aliases that own
 * a class scope are accepted as targets.
 */
export function detectTypeScriptReceiverImplementations(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): StructuralImplementationResult {
  const objectAliases = objectTypeAliasIds(parsedFiles);
  const implementations = new Map<
    string,
    Array<{ readonly structDefId: string; readonly receiverForm: 'value' }>
  >();

  for (const parsed of parsedFiles) {
    const sideChannel = parsed.captureSideChannel as
      | TypeScriptReceiverImplementationSideChannel
      | undefined;
    if (sideChannel?.kind !== 'typescript-receiver-implementations') continue;

    for (const assertion of sideChannel.assertions) {
      const scope = smallestContainingScope(parsed, assertion);
      const classDef = classAtPosition(parsed, assertion);
      if (scope === undefined || classDef === undefined) continue;
      const alias = resolveAssertedObjectTypeAlias(
        parsed,
        scope,
        scope.id,
        assertion.typeName,
        indexes,
        objectAliases,
      );
      if (alias === undefined) continue;

      let implementors = implementations.get(alias.nodeId);
      if (implementors === undefined) {
        implementors = [];
        implementations.set(alias.nodeId, implementors);
      }
      if (implementors.some((implementor) => implementor.structDefId === classDef.nodeId)) continue;
      implementors.push({ structDefId: classDef.nodeId, receiverForm: 'value' });
    }
  }

  return { implementations, undecided: [] };
}
