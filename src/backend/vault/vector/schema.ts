import * as arrow from "apache-arrow";

export function memorySchema(dims: number): arrow.Schema {
  return new arrow.Schema([
    new arrow.Field("id", new arrow.Utf8(), false),
    new arrow.Field("project_id", new arrow.Utf8(), false),
    new arrow.Field("workspace_id", new arrow.Utf8(), true),
    new arrow.Field("scope", new arrow.Utf8(), false),
    new arrow.Field("author", new arrow.Utf8(), false),
    new arrow.Field("title", new arrow.Utf8(), false),
    new arrow.Field("archived", new arrow.Bool(), false),
    new arrow.Field("content_hash", new arrow.Utf8(), false),
    new arrow.Field(
      "vector",
      new arrow.FixedSizeList(
        dims,
        new arrow.Field("item", new arrow.Float32(), true),
      ),
      false,
    ),
  ]);
}
