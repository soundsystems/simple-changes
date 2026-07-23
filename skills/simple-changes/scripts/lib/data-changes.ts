export type DataChangeKind =
  | "migration-history"
  | "schema-definition"
  | "query-or-routine"
  | "backfill-or-seed"
  | "index-or-projection";

const MIGRATION_PATH_PATTERN = /(^|\/)(migrate|migrations?|revisions?)(\/|$)/iu;
const CONTEXTUAL_HISTORY_PATTERN =
  /(^|\/)(db|database|data|storage|alembic|drizzle|liquibase|prisma)(\/.*)?\/(versions?|changesets?|changelogs?)(\/|$)/iu;
const SCHEMA_PATH_PATTERN =
  /(^|\/)(schemas?|models?|entities?)(\/|$)|(^|\/)schema\.(prisma|rb|sql|graphql|gql|json)$/iu;
const BACKFILL_PATH_PATTERN =
  /(^|\/)(backfills?|data-migrations?|repairs?|seeds?)(\/|$)/iu;
const INDEX_PATH_PATTERN =
  /(^|\/)(indexes?|indices|projections?|search-mappings?)(\/|$)/iu;
const DATA_CONTEXT_PATTERN = /(^|\/)(db|database|data|storage)(\/|$)/iu;
const QUERY_EXTENSION_PATTERN = /\.(sql|cql|cypher|sparql|rq|graphql|gql)$/iu;

export const classifyDataChange = (path: string): DataChangeKind | null => {
  if (BACKFILL_PATH_PATTERN.test(path)) {
    return "backfill-or-seed";
  }
  if (
    MIGRATION_PATH_PATTERN.test(path) ||
    CONTEXTUAL_HISTORY_PATTERN.test(path)
  ) {
    return "migration-history";
  }
  if (INDEX_PATH_PATTERN.test(path)) {
    return "index-or-projection";
  }
  if (SCHEMA_PATH_PATTERN.test(path)) {
    return "schema-definition";
  }
  if (DATA_CONTEXT_PATTERN.test(path) && QUERY_EXTENSION_PATTERN.test(path)) {
    return "query-or-routine";
  }
  return null;
};

export const dataChangeKinds = (paths: string[]): DataChangeKind[] => [
  ...new Set(
    paths
      .map(classifyDataChange)
      .filter((kind): kind is DataChangeKind => kind !== null)
  ),
];
