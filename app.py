import csv
import io
import os
from functools import wraps
from flask import Flask, jsonify, render_template, request, Response, session
import psycopg
from psycopg.rows import dict_row
from werkzeug.security import check_password_hash, generate_password_hash

app = Flask(__name__)
app.secret_key = "csu-nsrc-office-secret-key-change-in-prod"
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

# --- PostgreSQL / pgAdmin Connection Settings ---
DB_CONFIG = {
    "host": os.environ.get("PGHOST", "localhost"),
    "port": int(os.environ.get("PGPORT", 5432)),
    "dbname": os.environ.get("PGDATABASE", "csu_nsrc_db"),
    "user": os.environ.get("PGUSER", "postgres"),
    "password": os.environ.get("PGPASSWORD", "ROSEMARIE"),
}

_db_initialized = False


def ensure_database_exists():
    """Automatically creates csu_nsrc_db in PostgreSQL if it does not exist yet."""
    admin_config = {**DB_CONFIG, "dbname": "postgres"}
    with psycopg.connect(**admin_config, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (DB_CONFIG["dbname"],))
            if not cur.fetchone():
                cur.execute(f'CREATE DATABASE "{DB_CONFIG["dbname"]}"')


def get_db():
    return psycopg.connect(**DB_CONFIG, row_factory=dict_row)


def init_db():
    ensure_database_exists()
    db = get_db()
    cur = db.cursor()

    schema_statements = [
        """
        CREATE TABLE IF NOT EXISTS colleges (
            college_id SERIAL PRIMARY KEY,
            college_code TEXT NOT NULL UNIQUE,
            college_name TEXT NOT NULL,
            account_handle TEXT NOT NULL UNIQUE
        );
        """,
        """
        CREATE TABLE IF NOT EXISTS users (
            user_id SERIAL PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            full_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('CSU_NSRC_ADMIN', 'COLLEGE_FOCAL')),
            college_id INTEGER NULL REFERENCES colleges(college_id) ON DELETE SET NULL
        );
        """,
        """
        CREATE TABLE IF NOT EXISTS incidents (
            incident_id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            hazard_type TEXT NOT NULL,
            incident_date TEXT,
            status TEXT DEFAULT 'Active' CHECK(status IN ('Active', 'Closed'))
        );
        """,
        """
        CREATE TABLE IF NOT EXISTS evacuation_centers (
            center_id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            location TEXT NOT NULL,
            max_capacity INTEGER NOT NULL,
            current_occupancy INTEGER DEFAULT 0,
            status TEXT DEFAULT 'Open' CHECK(status IN ('Open', 'Near Full', 'Full', 'Closed')),
            amenities TEXT
        );
        """,
        """
        CREATE TABLE IF NOT EXISTS affected_students (
            record_id SERIAL PRIMARY KEY,
            incident_id INTEGER NOT NULL REFERENCES incidents(incident_id),
            college_id INTEGER NOT NULL REFERENCES colleges(college_id),
            student_id TEXT NOT NULL,
            full_name TEXT NOT NULL,
            program TEXT NOT NULL,
            address TEXT NOT NULL,
            boarding_house TEXT DEFAULT '',
            contact_number TEXT,
            impact_type TEXT NOT NULL,
            current_status TEXT DEFAULT 'Submitted',
            assigned_center_id INTEGER NULL REFERENCES evacuation_centers(center_id),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(incident_id, student_id)
        );
        """,
        """
        CREATE TABLE IF NOT EXISTS action_logs (
            log_id SERIAL PRIMARY KEY,
            record_id INTEGER NOT NULL REFERENCES affected_students(record_id) ON DELETE CASCADE,
            updated_by INTEGER NOT NULL REFERENCES users(user_id),
            status TEXT NOT NULL,
            action_taken TEXT NOT NULL,
            logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        """,
        """
        CREATE TABLE IF NOT EXISTS partner_institutions (
            partner_id SERIAL PRIMARY KEY,
            institution_name TEXT NOT NULL,
            partner_type TEXT NOT NULL,
            contact_person TEXT,
            contact_details TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        """,
        """
        CREATE TABLE IF NOT EXISTS inventory_items (
            item_id SERIAL PRIMARY KEY,
            item_name TEXT NOT NULL,
            category TEXT NOT NULL,
            quantity_on_hand INTEGER DEFAULT 0,
            unit TEXT NOT NULL,
            reorder_threshold INTEGER DEFAULT 20
        );
        """,
        """
        CREATE TABLE IF NOT EXISTS relief_transactions (
            tx_id SERIAL PRIMARY KEY,
            incident_id INTEGER NOT NULL REFERENCES incidents(incident_id),
            item_id INTEGER NOT NULL REFERENCES inventory_items(item_id),
            partner_id INTEGER NULL REFERENCES partner_institutions(partner_id) ON DELETE SET NULL,
            tx_type TEXT NOT NULL CHECK(tx_type IN ('IN', 'OUT')),
            quantity INTEGER NOT NULL,
            source_or_recipient TEXT NOT NULL,
            recorded_by INTEGER NOT NULL REFERENCES users(user_id),
            logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        """,
        """
        ALTER TABLE affected_students
        ADD COLUMN IF NOT EXISTS boarding_house TEXT DEFAULT '';
        """,
    ]

    for stmt in schema_statements:
        cur.execute(stmt)

    # Seed ONLY the 7 CSU colleges and 8 login accounts
    cur.execute("SELECT COUNT(*) AS cnt FROM colleges")
    if cur.fetchone()["cnt"] == 0:
        colleges = [
            ("CAA", "College of Agriculture and Agri-Industries", "CSU-CAA"),
            ("CCIS", "College of Computing and Information Sciences", "CSU-CCIS"),
            ("CED", "College of Education", "CSU-CED"),
            ("CEGS", "College of Engineering and Geosciences", "CSU-CEGS"),
            ("CHASS", "College of Humanities and Social Sciences", "CSU-CHASS"),
            ("CMNS", "College of Mathematics and Natural Sciences", "CSU-CMNS"),
            ("COFES", "College of Forestry and Environmental Sciences", "CSU-COFES"),
        ]
        cur.executemany(
            "INSERT INTO colleges (college_code, college_name, account_handle) VALUES (%s, %s, %s)",
            colleges,
        )

        default_pw = generate_password_hash("csu123")
        users = [
            ("CSU-NSRC", "CSU NSRC Central Admin", default_pw, "CSU_NSRC_ADMIN", None),
            ("CSU-CAA", "CAA Focal Person", default_pw, "COLLEGE_FOCAL", 1),
            ("CSU-CCIS", "CCIS Focal Person", default_pw, "COLLEGE_FOCAL", 2),
            ("CSU-CED", "CED Focal Person", default_pw, "COLLEGE_FOCAL", 3),
            ("CSU-CEGS", "CEGS Focal Person", default_pw, "COLLEGE_FOCAL", 4),
            ("CSU-CHASS", "CHASS Focal Person", default_pw, "COLLEGE_FOCAL", 5),
            ("CSU-CMNS", "CMNS Focal Person", default_pw, "COLLEGE_FOCAL", 6),
            ("CSU-COFES", "COFES Focal Person", default_pw, "COLLEGE_FOCAL", 7),
        ]
        cur.executemany(
            "INSERT INTO users (username, full_name, password_hash, role, college_id) VALUES (%s, %s, %s, %s, %s)",
            users,
        )

    db.commit()
    db.close()


@app.before_request
def ensure_schema():
    global _db_initialized
    if not _db_initialized:
        init_db()
        _db_initialized = True


# --- Auth Decorators ---
def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"error": "Authentication required"}), 401
        return f(*args, **kwargs)
    return decorated


def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if session.get("role") != "CSU_NSRC_ADMIN":
            return jsonify({"error": "CSU NSRC Admin privileges required"}), 403
        return f(*args, **kwargs)
    return decorated


# --- Routes ---
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/session", methods=["GET"])
def get_session():
    if "user_id" not in session:
        return jsonify({"authenticated": False})
    return jsonify({
        "authenticated": True,
        "user": {
            "user_id": session["user_id"],
            "username": session["username"],
            "full_name": session["full_name"],
            "role": session["role"],
            "college_id": session["college_id"],
            "college_code": session.get("college_code"),
            "college_name": session.get("college_name"),
        }
    })


@app.route("/api/login", methods=["POST"])
def login():
    data = request.json or {}
    username = data.get("username", "").strip().upper()
    password = data.get("password", "")

    db = get_db()
    cur = db.cursor()
    cur.execute("""
        SELECT u.*, c.college_code, c.college_name
        FROM users u
        LEFT JOIN colleges c ON u.college_id = c.college_id
        WHERE UPPER(u.username) = %s
    """, (username,))
    user = cur.fetchone()
    db.close()

    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Invalid office selection or password."}), 401

    session["user_id"] = user["user_id"]
    session["username"] = user["username"]
    session["full_name"] = user["full_name"]
    session["role"] = user["role"]
    session["college_id"] = user["college_id"]
    session["college_code"] = user["college_code"]
    session["college_name"] = user["college_name"]

    return jsonify({"message": "Logged in successfully."})


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"message": "Logged out."})


@app.route("/api/incidents", methods=["GET", "POST"])
@login_required
def handle_incidents():
    db = get_db()
    cur = db.cursor()

    if request.method == "POST":
        if session.get("role") != "CSU_NSRC_ADMIN":
            db.close()
            return jsonify({"error": "Only CSU NSRC Admin can declare incidents."}), 403
        data = request.json
        cur.execute(
            """
            INSERT INTO incidents (title, hazard_type, incident_date, status)
            VALUES (%s, %s, %s, 'Active')
            RETURNING incident_id
            """,
            (data["title"].strip(), data["hazard_type"], data.get("incident_date", "").strip()),
        )
        new_id = cur.fetchone()["incident_id"]
        db.commit()
        db.close()
        return jsonify({"message": "Incident recorded.", "incident_id": new_id}), 201

    cur.execute("""
        SELECT i.*, COUNT(s.record_id) AS student_count
        FROM incidents i
        LEFT JOIN affected_students s ON i.incident_id = s.incident_id
        GROUP BY i.incident_id
        ORDER BY i.incident_id DESC
    """)
    incidents = [dict(row) for row in cur.fetchall()]
    db.close()
    return jsonify(incidents)


@app.route("/api/incidents/<int:incident_id>/close", methods=["PATCH"])
@login_required
@admin_required
def close_incident(incident_id):
    db = get_db()
    cur = db.cursor()
    cur.execute("UPDATE incidents SET status = 'Closed' WHERE incident_id = %s", (incident_id,))
    db.commit()
    db.close()
    return jsonify({"message": "Incident marked as Closed."})


@app.route("/api/dashboard/<int:incident_id>", methods=["GET"])
@login_required
def get_dashboard(incident_id):
    db = get_db()
    cur = db.cursor()
    role = session["role"]
    user_college_id = session["college_id"]

    cur.execute("""
        SELECT c.college_id, c.college_code, c.college_name,
               COUNT(s.record_id) AS total_affected,
               COALESCE(SUM(CASE WHEN s.current_status = 'Submitted' THEN 1 ELSE 0 END), 0) AS submitted,
               COALESCE(SUM(CASE WHEN s.current_status IN ('Received / Verified', 'Action in Progress') THEN 1 ELSE 0 END), 0) AS in_progress,
               COALESCE(SUM(CASE WHEN s.current_status = 'Assisted / Sheltered' THEN 1 ELSE 0 END), 0) AS sheltered,
               COALESCE(SUM(CASE WHEN s.current_status = 'Resolved' THEN 1 ELSE 0 END), 0) AS resolved
        FROM colleges c
        LEFT JOIN affected_students s
          ON c.college_id = s.college_id AND s.incident_id = %s
        GROUP BY c.college_id
        ORDER BY c.college_code
    """, (incident_id,))
    college_stats = [dict(r) for r in cur.fetchall()]

    if role == "CSU_NSRC_ADMIN":
        cur.execute("""
            SELECT s.*, c.college_code, c.college_name, e.name AS center_name
            FROM affected_students s
            JOIN colleges c ON s.college_id = c.college_id
            LEFT JOIN evacuation_centers e ON s.assigned_center_id = e.center_id
            WHERE s.incident_id = %s
            ORDER BY s.updated_at DESC, s.record_id DESC
        """, (incident_id,))
    else:
        cur.execute("""
            SELECT s.*, c.college_code, c.college_name, e.name AS center_name
            FROM affected_students s
            JOIN colleges c ON s.college_id = c.college_id
            LEFT JOIN evacuation_centers e ON s.assigned_center_id = e.center_id
            WHERE s.incident_id = %s AND s.college_id = %s
            ORDER BY s.updated_at DESC, s.record_id DESC
        """, (incident_id, user_college_id))
    students = [dict(r) for r in cur.fetchall()]

    cur.execute("""
        SELECT e.*,
               COUNT(s.record_id) AS assigned_students_count
        FROM evacuation_centers e
        LEFT JOIN affected_students s
          ON e.center_id = s.assigned_center_id AND s.incident_id = %s
        GROUP BY e.center_id
        ORDER BY e.name
    """, (incident_id,))
    centers = [dict(r) for r in cur.fetchall()]

    cur.execute("SELECT * FROM inventory_items ORDER BY category, item_name")
    inventory = [dict(r) for r in cur.fetchall()]

    cur.execute("SELECT * FROM partner_institutions ORDER BY institution_name")
    partners = [dict(r) for r in cur.fetchall()]

    cur.execute("""
        SELECT t.*, i.item_name, i.unit, p.institution_name, u.username AS recorded_by_name
        FROM relief_transactions t
        JOIN inventory_items i ON t.item_id = i.item_id
        LEFT JOIN partner_institutions p ON t.partner_id = p.partner_id
        JOIN users u ON t.recorded_by = u.user_id
        WHERE t.incident_id = %s
        ORDER BY t.tx_id DESC
    """, (incident_id,))
    transactions = [dict(r) for r in cur.fetchall()]

    db.close()
    return jsonify({
        "college_stats": college_stats,
        "students": students,
        "evacuation_centers": centers,
        "inventory": inventory,
        "partners": partners,
        "transactions": transactions,
    })


@app.route("/api/students", methods=["POST"])
@login_required
def submit_student():
    data = request.json
    incident_id = data.get("incident_id")
    if not incident_id:
        return jsonify({"error": "No active incident found. Ask CSU NSRC Admin to record an incident first."}), 400

    user_id = session["user_id"]
    college_id = session["college_id"] if session["role"] == "COLLEGE_FOCAL" else data.get("college_id")

    if not college_id:
        return jsonify({"error": "College assignment is required."}), 400

    db = get_db()
    cur = db.cursor()

    cur.execute("""
        SELECT s.record_id, s.full_name, s.current_status, c.college_code
        FROM affected_students s
        JOIN colleges c ON s.college_id = c.college_id
        WHERE s.incident_id = %s AND UPPER(s.student_id) = UPPER(%s)
    """, (incident_id, data["student_id"].strip()))
    existing = cur.fetchone()

    if existing:
        db.close()
        return jsonify({
            "error": f"Student ID {data['student_id']} is already recorded under {existing['college_code']} (Status: {existing['current_status']}).",
            "existing_record": dict(existing)
        }), 409

    cur.execute("""
        INSERT INTO affected_students
        (incident_id, college_id, student_id, full_name, program, address, boarding_house, contact_number, impact_type)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING record_id
    """, (
        incident_id,
        college_id,
        data["student_id"].strip(),
        data["full_name"].strip(),
        data["program"].strip(),
        data["address"].strip(),
        data.get("boarding_house", "").strip(),
        data.get("contact_number", "").strip(),
        data["impact_type"],
    ))
    record_id = cur.fetchone()["record_id"]

    cur.execute("""
        INSERT INTO action_logs (record_id, updated_by, status, action_taken)
        VALUES (%s, %s, 'Submitted', %s)
    """, (record_id, user_id, f"Submitted by {session['username']}."))

    db.commit()
    db.close()
    return jsonify({"message": "Affected student report submitted.", "record_id": record_id}), 201


@app.route("/api/students/<int:record_id>", methods=["PUT"])
@login_required
def update_student_details(record_id):
    data = request.json
    db = get_db()
    cur = db.cursor()

    cur.execute("SELECT * FROM affected_students WHERE record_id = %s", (record_id,))
    student = cur.fetchone()
    if not student:
        db.close()
        return jsonify({"error": "Student record not found."}), 404

    if session["role"] == "COLLEGE_FOCAL" and student["college_id"] != session["college_id"]:
        db.close()
        return jsonify({"error": "You can only update records submitted by your college."}), 403

    cur.execute("""
        UPDATE affected_students
        SET full_name = %s,
            program = %s,
            address = %s,
            boarding_house = %s,
            contact_number = %s,
            impact_type = %s,
            updated_at = CURRENT_TIMESTAMP
        WHERE record_id = %s
    """, (
        data["full_name"].strip(),
        data["program"].strip(),
        data["address"].strip(),
        data.get("boarding_house", "").strip(),
        data.get("contact_number", "").strip(),
        data["impact_type"],
        record_id,
    ))

    note = data.get("update_note", "").strip() or f"Record details updated by {session['username']}."
    cur.execute("""
        INSERT INTO action_logs (record_id, updated_by, status, action_taken)
        VALUES (%s, %s, %s, %s)
    """, (record_id, session["user_id"], student["current_status"], note))

    db.commit()
    db.close()
    return jsonify({"message": "Submitted record updated successfully."})


@app.route("/api/students/<int:record_id>/logs", methods=["GET"])
@login_required
def get_student_logs(record_id):
    db = get_db()
    cur = db.cursor()
    cur.execute("""
        SELECT l.*, u.username, u.full_name
        FROM action_logs l
        JOIN users u ON l.updated_by = u.user_id
        WHERE l.record_id = %s
        ORDER BY l.log_id DESC
    """, (record_id,))
    logs = [dict(r) for r in cur.fetchall()]
    db.close()
    return jsonify(logs)


@app.route("/api/students/<int:record_id>/status", methods=["PATCH"])
@login_required
@admin_required
def update_student_status(record_id):
    data = request.json
    new_status = data["status"]
    action_taken = data["action_taken"].strip()
    center_id = data.get("assigned_center_id") or None

    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT assigned_center_id FROM affected_students WHERE record_id = %s", (record_id,))
    student = cur.fetchone()
    if not student:
        db.close()
        return jsonify({"error": "Student record not found."}), 404

    old_center_id = student["assigned_center_id"]

    if center_id and int(center_id) != old_center_id:
        center_id = int(center_id)
        cur.execute("SELECT max_capacity, current_occupancy FROM evacuation_centers WHERE center_id = %s", (center_id,))
        center = cur.fetchone()
        if not center or center["current_occupancy"] >= center["max_capacity"]:
            db.close()
            return jsonify({"error": "Selected evacuation center is at full capacity."}), 400

        new_occ = center["current_occupancy"] + 1
        c_status = "Full" if new_occ >= center["max_capacity"] else ("Near Full" if new_occ >= center["max_capacity"] * 0.85 else "Open")
        cur.execute(
            "UPDATE evacuation_centers SET current_occupancy = %s, status = %s WHERE center_id = %s",
            (new_occ, c_status, center_id),
        )

    cur.execute("""
        UPDATE affected_students
        SET current_status = %s,
            assigned_center_id = COALESCE(%s, assigned_center_id),
            updated_at = CURRENT_TIMESTAMP
        WHERE record_id = %s
    """, (new_status, center_id, record_id))

    cur.execute("""
        INSERT INTO action_logs (record_id, updated_by, status, action_taken)
        VALUES (%s, %s, %s, %s)
    """, (record_id, session["user_id"], new_status, action_taken))

    db.commit()
    db.close()
    return jsonify({"message": "Student case updated."})


@app.route("/api/centers", methods=["POST"])
@login_required
@admin_required
def add_center():
    data = request.json
    max_cap = int(data["max_capacity"])
    if max_cap <= 0:
        return jsonify({"error": "Maximum capacity must be greater than zero."}), 400

    db = get_db()
    cur = db.cursor()
    cur.execute("""
        INSERT INTO evacuation_centers (name, location, max_capacity, current_occupancy, status, amenities)
        VALUES (%s, %s, %s, 0, 'Open', %s)
        RETURNING center_id
    """, (
        data["name"].strip(),
        data["location"].strip(),
        max_cap,
        data.get("amenities", "").strip(),
    ))
    center_id = cur.fetchone()["center_id"]
    db.commit()
    db.close()
    return jsonify({"message": "Evacuation center added.", "center_id": center_id}), 201


@app.route("/api/centers/<int:center_id>/occupancy", methods=["PATCH"])
@login_required
@admin_required
def adjust_center_occupancy(center_id):
    delta = int(request.json.get("delta", 0))
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT max_capacity, current_occupancy FROM evacuation_centers WHERE center_id = %s", (center_id,))
    center = cur.fetchone()
    if not center:
        db.close()
        return jsonify({"error": "Center not found."}), 404

    new_occ = max(0, min(center["max_capacity"], center["current_occupancy"] + delta))
    c_status = "Full" if new_occ >= center["max_capacity"] else ("Near Full" if new_occ >= center["max_capacity"] * 0.85 else "Open")
    cur.execute("UPDATE evacuation_centers SET current_occupancy = %s, status = %s WHERE center_id = %s", (new_occ, c_status, center_id))
    db.commit()
    db.close()
    return jsonify({"message": "Evacuation center updated."})


@app.route("/api/partners", methods=["POST"])
@login_required
@admin_required
def add_partner():
    data = request.json
    db = get_db()
    cur = db.cursor()
    cur.execute("""
        INSERT INTO partner_institutions (institution_name, partner_type, contact_person, contact_details)
        VALUES (%s, %s, %s, %s)
        RETURNING partner_id
    """, (
        data["institution_name"].strip(),
        data["partner_type"],
        data.get("contact_person", "").strip(),
        data.get("contact_details", "").strip(),
    ))
    partner_id = cur.fetchone()["partner_id"]
    db.commit()
    db.close()
    return jsonify({"message": "Partner institution registered.", "partner_id": partner_id}), 201


@app.route("/api/inventory", methods=["POST"])
@login_required
@admin_required
def add_inventory_item():
    data = request.json
    db = get_db()
    cur = db.cursor()
    cur.execute("""
        INSERT INTO inventory_items (item_name, category, quantity_on_hand, unit, reorder_threshold)
        VALUES (%s, %s, 0, %s, %s)
        RETURNING item_id
    """, (
        data["item_name"].strip(),
        data["category"],
        data["unit"].strip(),
        int(data["reorder_threshold"]),
    ))
    item_id = cur.fetchone()["item_id"]
    db.commit()
    db.close()
    return jsonify({"message": "Relief item added.", "item_id": item_id}), 201


@app.route("/api/inventory/transactions", methods=["POST"])
@login_required
@admin_required
def record_transaction():
    data = request.json
    incident_id = data.get("incident_id")
    if not incident_id:
        return jsonify({"error": "Please record an active incident first."}), 400

    tx_type = data["tx_type"]
    qty = int(data["quantity"])
    item_id = int(data["item_id"])
    partner_id = int(data["partner_id"]) if data.get("partner_id") else None

    if qty <= 0:
        return jsonify({"error": "Quantity must be greater than zero."}), 400

    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT quantity_on_hand FROM inventory_items WHERE item_id = %s", (item_id,))
    item = cur.fetchone()
    if not item:
        db.close()
        return jsonify({"error": "Inventory item not found."}), 404

    if tx_type == "OUT" and item["quantity_on_hand"] < qty:
        db.close()
        return jsonify({"error": "Insufficient stock available for release."}), 400

    new_qty = item["quantity_on_hand"] + qty if tx_type == "IN" else item["quantity_on_hand"] - qty
    cur.execute("UPDATE inventory_items SET quantity_on_hand = %s WHERE item_id = %s", (new_qty, item_id))

    cur.execute("""
        INSERT INTO relief_transactions
        (incident_id, item_id, partner_id, tx_type, quantity, source_or_recipient, recorded_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
    """, (
        incident_id,
        item_id,
        partner_id,
        tx_type,
        qty,
        data["source_or_recipient"].strip(),
        session["user_id"],
    ))

    db.commit()
    db.close()
    return jsonify({"message": f"Relief {tx_type} transaction recorded."}), 201


@app.route("/api/incidents/<int:incident_id>/export", methods=["GET"])
@login_required
@admin_required
def export_aftermath_csv(incident_id):
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT * FROM incidents WHERE incident_id = %s", (incident_id,))
    incident = cur.fetchone()

    cur.execute("""
        SELECT c.college_code, c.college_name, s.student_id, s.full_name, s.program,
               s.address, COALESCE(s.boarding_house, '') AS boarding_house,
               s.contact_number, s.impact_type, s.current_status,
               COALESCE(e.name, 'None') AS evacuation_center
        FROM affected_students s
        JOIN colleges c ON s.college_id = c.college_id
        LEFT JOIN evacuation_centers e ON s.assigned_center_id = e.center_id
        WHERE s.incident_id = %s
        ORDER BY c.college_code, s.full_name
    """, (incident_id,))
    rows = cur.fetchall()
    db.close()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["CSU NSRC AFTERMATH REPORT", incident["title"] if incident else f"Incident #{incident_id}"])
    writer.writerow([])
    writer.writerow([
        "College Code", "College Name", "Student ID", "Full Name", "Program",
        "Address", "Boarding House", "Contact Number", "Impact Type", "Current Status",
        "Assigned Evacuation Center"
    ])
    for r in rows:
        writer.writerow([
            r["college_code"], r["college_name"], r["student_id"], r["full_name"],
            r["program"], r["address"], r["boarding_house"], r["contact_number"],
            r["impact_type"], r["current_status"], r["evacuation_center"]
        ])

    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename=CSU_NSRC_Aftermath_Report_Incident_{incident_id}.csv"},
    )


if __name__ == "__main__":
    init_db()
    app.run(debug=True, port=5000)