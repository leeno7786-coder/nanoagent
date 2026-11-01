/**
 * Types for the memory graph system
 */

export interface GraphNode {
  id: string;
  type: 'file' | 'function' | 'class' | 'variable' | 'type' | 'module' | 'dependency' | 'concept';
  name: string;
  description?: string;
  path?: string;
  line?: number;
  column?: number;
  code?: string;
  language?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type:
    | 'imports'
    | 'exports'
    | 'calls'
    | 'uses'
    | 'extends'
    | 'implements'
    | 'depends_on'
    | 'related_to'
    | 'part_of';
  weight?: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt?: number;
  extraction?: 'ast' | 'inferred' | 'llm';
}

export interface GraphCommunity {
  id: number;
  size: number;
  nodes: GraphNode[];
  internalEdges: number;
  externalEdges: number;
  density: number;
  topNodeIds: string[];
  nodeIds: string[];
}

export interface GodNode {
  node: GraphNode;
  degree: number;
  inDegree: number;
  outDegree: number;
  betweenness?: number;
}

export interface GraphAnalysis {
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  modularity: number;
  isolatedNodes: number;
  density: number;
  communities: GraphCommunity[];
  godNodes: GodNode[];
  surprisingConnections: Array<{
    edge: GraphEdge;
    sourceCommunity: number;
    targetCommunity: number;
  }>;
  topLanguages: Array<{ language: string; count: number }>;
  topTypes: Array<{ type: string; count: number }>;
}

export type ExtractionQuality = 'ast' | 'inferred' | 'llm';

export interface GraphData {
  version: string;
  lastUpdated: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphQuery {
  type: 'node' | 'edge' | 'path' | 'pattern' | 'semantic';
  query: string | Record<string, unknown>;
  limit?: number;
  offset?: number;
}

export interface GraphQueryResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  paths: string[][];
  stats: {
    nodeCount: number;
    edgeCount: number;
    queryTime: number;
  };
}

export interface GraphIndexOptions {
  indexTypes?: boolean;
  indexPaths?: boolean;
  indexNames?: boolean;
  indexByLanguage?: boolean;
}

export interface GraphBuildOptions {
  includeDependencies?: boolean;
  includeCode?: boolean;
  maxFileSize?: number;
  /** Hard cap on indexed files — a safety valve for huge workspaces. */
  maxFiles?: number;
  excludedPaths?: string[];
  includedPaths?: string[];
  /** Honor .gitignore files during the walk (default true). */
  respectGitignore?: boolean;
}

export type NodeType = GraphNode['type'];
export type EdgeType = GraphEdge['type'];
