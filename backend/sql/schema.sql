-- Forte Community Clinic — lean schema (Microsoft SQL Server)
-- Run this against your empty database once.

CREATE TABLE Patient (
  Patient_ID        INT IDENTITY(1,1) PRIMARY KEY,
  FirstName         NVARCHAR(100) NOT NULL,
  LastName          NVARCHAR(100) NOT NULL,
  ContactNumber     NVARCHAR(20),
  Email             NVARCHAR(255) NOT NULL UNIQUE,
  PasswordHash      NVARCHAR(255) NOT NULL,
  IsActive          BIT NOT NULL DEFAULT 1,
  DateOfBirth       DATE,
  Gender            NVARCHAR(20),
  EmergencyContact  NVARCHAR(20),
  Address           NVARCHAR(500),
  AccountBalance    DECIMAL(12,2) NOT NULL DEFAULT 0,
  CreatedDate       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

CREATE TABLE Employee (
  Employee_ID       INT IDENTITY(1,1) PRIMARY KEY,
  FirstName         NVARCHAR(100) NOT NULL,
  LastName          NVARCHAR(100) NOT NULL,
  ContactNumber     NVARCHAR(20),
  Email             NVARCHAR(255) NOT NULL UNIQUE,
  PasswordHash      NVARCHAR(255) NOT NULL,
  IsActive          BIT NOT NULL DEFAULT 1,
  EmployeeType      NVARCHAR(50) NOT NULL, -- Doctor, Nurse, Pharmacist, Receptionist, Manager, Admin
  HPCSANumber       NVARCHAR(50),
  Address           NVARCHAR(500),
  HireDate          DATE
);

CREATE UNIQUE INDEX UQ_Employee_HPCSANumber_NotNull
  ON Employee (HPCSANumber)
  WHERE HPCSANumber IS NOT NULL;

CREATE TABLE Appointment (
  Appointment_ID    INT IDENTITY(1,1) PRIMARY KEY,
  Patient_ID        INT NOT NULL REFERENCES Patient(Patient_ID),
  Employee_ID       INT NULL REFERENCES Employee(Employee_ID),
  AppointmentDate   DATE NOT NULL,
  AppointmentTime   TIME NOT NULL,
  Reason            NVARCHAR(500),
  Status            NVARCHAR(30) NOT NULL DEFAULT 'Scheduled', -- Scheduled, Completed, Cancelled, No-show
  CreatedDate       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

CREATE TABLE Consultation (
  Consultation_ID   INT IDENTITY(1,1) PRIMARY KEY,
  Appointment_ID    INT NULL REFERENCES Appointment(Appointment_ID),
  Patient_ID        INT NOT NULL REFERENCES Patient(Patient_ID),
  Employee_ID       INT NOT NULL REFERENCES Employee(Employee_ID),
  ConsultationDate  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  ConsultationDuration INT NOT NULL DEFAULT 15,
  Notes             NVARCHAR(MAX),
  ConsultationNotes NVARCHAR(MAX),
  ComplaintInfo     NVARCHAR(2000),
  PatientBP         NVARCHAR(50),
  PatientHR         INT,
  PatientTemp       DECIMAL(5,2),
  PatientWeight     DECIMAL(6,2),
  PatientExamination NVARCHAR(MAX),
  SeverityStatus    NVARCHAR(30),
  DiagnosisSummary  NVARCHAR(1000)
);

CREATE TABLE Diagnose (
  Diagnose_ID       INT IDENTITY(1,1) PRIMARY KEY,
  DiagnoseName      NVARCHAR(200) NOT NULL,
  Severity          NVARCHAR(30) -- Mild, Moderate, Severe
);

CREATE TABLE ConsultationDiagnose (
  Consultation_ID   INT NOT NULL REFERENCES Consultation(Consultation_ID),
  Diagnose_ID       INT NOT NULL REFERENCES Diagnose(Diagnose_ID),
  PRIMARY KEY (Consultation_ID, Diagnose_ID)
);

CREATE TABLE Inventory (
  Inventory_ID      INT IDENTITY(1,1) PRIMARY KEY,
  MedicationName    NVARCHAR(200) NOT NULL,
  Concentration     NVARCHAR(50),
  MedicationType    NVARCHAR(100),
  ManufacturedDate  DATE,
  ExpiryDate        DATE,
  StockQuantity     INT NOT NULL DEFAULT 0,
  UnitPrice         DECIMAL(12,2) NOT NULL DEFAULT 0,
  ReorderLevel      INT NOT NULL DEFAULT 0,
  LastUpdated       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

CREATE TABLE Prescription (
  Prescription_ID   INT IDENTITY(1,1) PRIMARY KEY,
  Consultation_ID   INT NOT NULL REFERENCES Consultation(Consultation_ID),
  Inventory_ID      INT NOT NULL REFERENCES Inventory(Inventory_ID),
  Quantity          INT NOT NULL,
  DosageInstructions NVARCHAR(500),
  IsDispensed       BIT NOT NULL DEFAULT 0,
  DispensedDate     DATETIME2 NULL
);

CREATE TABLE Payment (
  Payment_ID        INT IDENTITY(1,1) PRIMARY KEY,
  Patient_ID        INT NOT NULL REFERENCES Patient(Patient_ID),
  ServiceName       NVARCHAR(200) NOT NULL,
  ServicePrice      DECIMAL(12,2) NOT NULL,
  PaymentType       NVARCHAR(50), -- Cash, Card, EFT, Medical Aid
  PaymentAmount     DECIMAL(12,2) NOT NULL DEFAULT 0,
  PaymentDate       DATE,
  IsPaid            NVARCHAR(10) NOT NULL DEFAULT 'No' -- Yes / No
);

CREATE TABLE AuditLog (
  AuditLog_ID       INT IDENTITY(1,1) PRIMARY KEY,
  UserType          NVARCHAR(50),
  User_ID           INT,
  EventCategory     NVARCHAR(100),
  ActionType        NVARCHAR(100),
  TableAffected     NVARCHAR(100),
  RecordID          INT,
  IPAddress         NVARCHAR(50),
  EventTime         DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  EventDetails      NVARCHAR(MAX)
);
