IF OBJECT_ID(N'dbo.PasswordResetToken', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.PasswordResetToken (
    Token_ID     BIGINT IDENTITY(1,1) PRIMARY KEY,
    UserType     NVARCHAR(20) NOT NULL CHECK (UserType IN ('Patient', 'Employee')),
    User_ID      INT NOT NULL,
    TokenHash    CHAR(64) NOT NULL UNIQUE,
    ExpiresAt    DATETIME2 NOT NULL,
    CreatedAt    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    UsedAt       DATETIME2 NULL
  );
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'dbo.PasswordResetToken')
    AND name = N'IX_PasswordResetToken_User_Created'
)
BEGIN
  CREATE INDEX IX_PasswordResetToken_User_Created
    ON dbo.PasswordResetToken (UserType, User_ID, CreatedAt DESC);
END;
