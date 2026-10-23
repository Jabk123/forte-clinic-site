-- Allow multiple employees without an HPCSA number while keeping supplied
-- HPCSA numbers unique. Run once against the existing clinic database.
DECLARE @EmployeeObjectId INT = OBJECT_ID(N'dbo.Employee', N'U');

IF @EmployeeObjectId IS NULL
  THROW 50000, 'dbo.Employee does not exist in the current database.', 1;

DECLARE @ConstraintName SYSNAME;
DECLARE @Sql NVARCHAR(MAX);

SELECT TOP (1) @ConstraintName = kc.name
FROM sys.key_constraints AS kc
WHERE kc.parent_object_id = @EmployeeObjectId
  AND kc.type = 'U'
  AND (
    SELECT COUNT(*)
    FROM sys.index_columns AS key_columns
    WHERE key_columns.object_id = kc.parent_object_id
      AND key_columns.index_id = kc.unique_index_id
      AND key_columns.key_ordinal > 0
  ) = 1
  AND EXISTS (
    SELECT 1
    FROM sys.index_columns AS key_column
    INNER JOIN sys.columns AS column_info
      ON column_info.object_id = key_column.object_id
      AND column_info.column_id = key_column.column_id
    WHERE key_column.object_id = kc.parent_object_id
      AND key_column.index_id = kc.unique_index_id
      AND key_column.key_ordinal = 1
      AND column_info.name = N'HPCSANumber'
  );

WHILE @ConstraintName IS NOT NULL
BEGIN
  SET @Sql = N'ALTER TABLE dbo.Employee DROP CONSTRAINT ' + QUOTENAME(@ConstraintName);
  EXEC sys.sp_executesql @Sql;
  SET @ConstraintName = NULL;

  SELECT TOP (1) @ConstraintName = kc.name
  FROM sys.key_constraints AS kc
  WHERE kc.parent_object_id = @EmployeeObjectId
    AND kc.type = 'U'
    AND (
      SELECT COUNT(*)
      FROM sys.index_columns AS key_columns
      WHERE key_columns.object_id = kc.parent_object_id
        AND key_columns.index_id = kc.unique_index_id
        AND key_columns.key_ordinal > 0
    ) = 1
    AND EXISTS (
      SELECT 1
      FROM sys.index_columns AS key_column
      INNER JOIN sys.columns AS column_info
        ON column_info.object_id = key_column.object_id
        AND column_info.column_id = key_column.column_id
      WHERE key_column.object_id = kc.parent_object_id
        AND key_column.index_id = kc.unique_index_id
        AND key_column.key_ordinal = 1
        AND column_info.name = N'HPCSANumber'
    );
END;

DECLARE @IndexName SYSNAME;

SELECT TOP (1) @IndexName = i.name
FROM sys.indexes AS i
WHERE i.object_id = @EmployeeObjectId
  AND i.is_unique = 1
  AND i.is_primary_key = 0
  AND i.is_unique_constraint = 0
  AND (
    SELECT COUNT(*)
    FROM sys.index_columns AS key_columns
    WHERE key_columns.object_id = i.object_id
      AND key_columns.index_id = i.index_id
      AND key_columns.key_ordinal > 0
  ) = 1
  AND EXISTS (
    SELECT 1
    FROM sys.index_columns AS key_column
    INNER JOIN sys.columns AS column_info
      ON column_info.object_id = key_column.object_id
      AND column_info.column_id = key_column.column_id
    WHERE key_column.object_id = i.object_id
      AND key_column.index_id = i.index_id
      AND key_column.key_ordinal = 1
      AND column_info.name = N'HPCSANumber'
  );

WHILE @IndexName IS NOT NULL
BEGIN
  SET @Sql = N'DROP INDEX ' + QUOTENAME(@IndexName) + N' ON dbo.Employee';
  EXEC sys.sp_executesql @Sql;
  SET @IndexName = NULL;

  SELECT TOP (1) @IndexName = i.name
  FROM sys.indexes AS i
  WHERE i.object_id = @EmployeeObjectId
    AND i.is_unique = 1
    AND i.is_primary_key = 0
    AND i.is_unique_constraint = 0
    AND (
      SELECT COUNT(*)
      FROM sys.index_columns AS key_columns
      WHERE key_columns.object_id = i.object_id
        AND key_columns.index_id = i.index_id
        AND key_columns.key_ordinal > 0
    ) = 1
    AND EXISTS (
      SELECT 1
      FROM sys.index_columns AS key_column
      INNER JOIN sys.columns AS column_info
        ON column_info.object_id = key_column.object_id
        AND column_info.column_id = key_column.column_id
      WHERE key_column.object_id = i.object_id
        AND key_column.index_id = i.index_id
        AND key_column.key_ordinal = 1
        AND column_info.name = N'HPCSANumber'
    );
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = @EmployeeObjectId
    AND name = N'UQ_Employee_HPCSANumber_NotNull'
)
BEGIN
  CREATE UNIQUE INDEX UQ_Employee_HPCSANumber_NotNull
    ON dbo.Employee (HPCSANumber)
    WHERE HPCSANumber IS NOT NULL;
END;
