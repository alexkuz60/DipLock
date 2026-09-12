CREATE DATABASE diplock;

-- Таблица сессий
CREATE TABLE IF NOT EXISTS sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename        TEXT,
    n_channels      INTEGER,
    sfreq           FLOAT,
    duration_sec    FLOAT,
    epoch_length_ms FLOAT,
    freq_band       TEXT,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Эпохи
CREATE TABLE IF NOT EXISTS epochs (
    id              SERIAL PRIMARY KEY,
    session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    epoch_index     INTEGER,
    start_time_sec  FLOAT,
    duration_ms     FLOAT,
    has_artifact    BOOLEAN DEFAULT FALSE,
    delta_power     FLOAT,
    theta_power     FLOAT,
    alpha_power     FLOAT,
    beta_power      FLOAT
);

-- Диполи
CREATE TABLE IF NOT EXISTS dipoles (
    id              SERIAL PRIMARY KEY,
    session_id      TEXT REFERENCES sessions(id),
    epoch_id        INTEGER REFERENCES epochs(id),
    time_ms         FLOAT,
    mni_x           FLOAT,
    mni_y           FLOAT,
    mni_z           FLOAT,
    amplitude_nam   FLOAT,
    gof             FLOAT,
    anatomical_roi  TEXT,
    brodmann_area   TEXT,
    freq_band       TEXT,
    trajectory_json JSONB   -- для анимации
);

-- Групповая статистика
CREATE TABLE IF NOT EXISTS group_analysis (
    id              SERIAL PRIMARY KEY,
    brodmann_area   TEXT,
    anatomical_roi  TEXT,
    freq_band       TEXT,
    n_sessions      INTEGER,
    avg_gof         FLOAT,
    avg_amplitude   FLOAT,
    std_amplitude   FLOAT,
    last_seen       TIMESTAMP DEFAULT NOW()
);

-- Индексы
CREATE INDEX idx_dipoles_ba   ON dipoles(brodmann_area);
CREATE INDEX idx_dipoles_roi  ON dipoles(anatomical_roi);
CREATE INDEX idx_dipoles_freq ON dipoles(freq_band);
CREATE INDEX idx_dipoles_mni  ON dipoles(mni_x, mni_y, mni_z);
