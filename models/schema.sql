-- ============================================
-- JK Healthcare — Database Schema
-- ============================================

-- 1. Roles (admin, doctor, receptionist, patient)
CREATE TABLE roles (
    id    SERIAL PRIMARY KEY,
    name  VARCHAR(50) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO roles (name) VALUES ('admin'), ('doctor'), ('receptionist'), ('patient');


-- 2. Users (all system users share this table)
--    Each user gets a unique RSA key pair for asymmetric JWT signing (RS256).
CREATE TABLE users (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    email       VARCHAR(100) UNIQUE NOT NULL,
    password    VARCHAR(150) NOT NULL,
    phone       VARCHAR(20),
    role_id     INT NOT NULL,
    public_key  TEXT NOT NULL,               -- PEM-encoded RSA public key
    private_key TEXT NOT NULL,               -- PEM-encoded RSA private key
    is_active   BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT
);


-- 2b. Refresh tokens (opaque tokens stored as SHA-256 hashes)
CREATE TABLE refresh_tokens (
    id          SERIAL PRIMARY KEY,
    user_id     INT NOT NULL,
    token_hash  VARCHAR(64) UNIQUE NOT NULL,  -- SHA-256 hex digest
    expires_at  TIMESTAMP NOT NULL,
    revoked     BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);


-- 3. Organizations (hospital / clinic)
CREATE TABLE organizations (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(150) NOT NULL,
    address      TEXT,
    city         VARCHAR(100) NOT NULL,
    phone        VARCHAR(20),
    email        VARCHAR(100),
    description  TEXT,
    image_url    TEXT,
    timings         TEXT,               -- e.g., JSON string of schedule
    working_days    TEXT,               -- e.g., JSON string or unused
    is_active    BOOLEAN DEFAULT TRUE,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- 4. Organization members (links users ↔ organizations with a role context)
CREATE TABLE org_members (
    id              SERIAL PRIMARY KEY,
    user_id         INT NOT NULL,
    organization_id INT NOT NULL,
    role            VARCHAR(50) NOT NULL,           -- 'admin' | 'doctor' | 'receptionist'
    joined_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, organization_id),
    FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);


-- 5. Doctors (extra profile data)
CREATE TABLE doctors (
    id              SERIAL PRIMARY KEY,
    user_id         INT UNIQUE NOT NULL,
    organization_id INT NOT NULL,
    specialization  VARCHAR(100),
    qualification   VARCHAR(150),
    experience_years INT,
    fees            DECIMAL(10, 2),
    timings         TEXT,             -- e.g., JSON string of schedule
    working_days    TEXT,             -- e.g., JSON string or unused
    description     TEXT,
    image_url       TEXT,
    FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);


-- 6. Receptionists (extra profile data)
CREATE TABLE receptionists (
    id              SERIAL PRIMARY KEY,
    user_id         INT UNIQUE NOT NULL,
    organization_id INT NOT NULL,
    shift           VARCHAR(50),                    -- e.g. 'morning', 'evening', 'night'
    FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);


-- 7. Patients
CREATE TABLE patients (
    id      SERIAL PRIMARY KEY,
    user_id INT UNIQUE NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);


-- 8. Appointments
CREATE TYPE appointment_status AS ENUM (
    'pending',
    'confirmed',
    'completed',
    'cancelled'
);

CREATE TABLE appointments (
    id               SERIAL PRIMARY KEY,
    appointment_time TIMESTAMP NOT NULL,
    status           appointment_status DEFAULT 'pending',
    doctor_id        INT NOT NULL,
    patient_id       INT NOT NULL,
    notes            TEXT,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (doctor_id)  REFERENCES doctors(id)  ON DELETE CASCADE,
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
);


-- ============================================
-- Indexes
-- ============================================
CREATE INDEX idx_users_email              ON users(email);
CREATE INDEX idx_users_role_id            ON users(role_id);

CREATE INDEX idx_refresh_tokens_user      ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash      ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_expires   ON refresh_tokens(expires_at);

CREATE INDEX idx_org_members_user         ON org_members(user_id);
CREATE INDEX idx_org_members_org          ON org_members(organization_id);

CREATE INDEX idx_doctors_user_id          ON doctors(user_id);
CREATE INDEX idx_doctors_organization_id  ON doctors(organization_id);

CREATE INDEX idx_receptionists_user_id    ON receptionists(user_id);
CREATE INDEX idx_receptionists_org_id     ON receptionists(organization_id);

CREATE INDEX idx_patients_user_id         ON patients(user_id);

CREATE INDEX idx_appointments_doctor      ON appointments(doctor_id);
CREATE INDEX idx_appointments_patient     ON appointments(patient_id);
CREATE INDEX idx_appointments_time        ON appointments(appointment_time);
