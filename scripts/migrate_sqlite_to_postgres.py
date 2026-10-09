"""Copy a complete local CampusFlow SQLite database into an empty PostgreSQL database.

Set CAMPUSFLOW_MIGRATION_DATABASE_URL to the PostgreSQL URL before running this script.
The script never modifies the SQLite source and refuses to write into a non-empty target.
"""

import os
import sys
from pathlib import Path

from sqlalchemy import create_engine, func, inspect, select, text
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import models as _models  # noqa: E402,F401
from app.db.session import Base, normalize_database_url  # noqa: E402


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python scripts/migrate_sqlite_to_postgres.py PATH_TO_SQLITE_DB")
        return 2

    source_path = Path(sys.argv[1]).expanduser().resolve()
    target_url = os.environ.get("CAMPUSFLOW_MIGRATION_DATABASE_URL", "").strip()
    if not source_path.is_file():
        print(f"SQLite file not found: {source_path}")
        return 2
    if not target_url or make_url(target_url).get_backend_name() != "postgresql":
        print("Set CAMPUSFLOW_MIGRATION_DATABASE_URL to a PostgreSQL URL before running.")
        return 2

    source = create_engine(f"sqlite:///{source_path.as_posix()}")
    target = create_engine(normalize_database_url(target_url))
    try:
        Base.metadata.create_all(target)
        target_tables = set(inspect(target).get_table_names())
        with target.connect() as connection:
            populated = [
                table.name
                for table in Base.metadata.sorted_tables
                if table.name in target_tables
                and connection.scalar(select(func.count()).select_from(table))
            ]
        if populated:
            print("Target database is not empty; no data was copied.")
            return 2

        tables = Base.metadata.sorted_tables
        with source.connect() as source_connection, target.begin() as target_connection:
            source_tables = set(inspect(source).get_table_names())
            source_columns = {
                table_name: {column["name"] for column in inspect(source).get_columns(table_name)}
                for table_name in source_tables
            }
            for table in tables:
                if table.name not in source_tables:
                    continue
                available_columns = [column for column in table.columns if column.name in source_columns[table.name]]
                rows = [
                    dict(row)
                    for row in source_connection.execute(
                        select(*available_columns).select_from(table)
                    ).mappings()
                ]
                if rows:
                    target_connection.execute(table.insert(), rows)

            if target.dialect.name == "postgresql":
                for table in tables:
                    if "id" not in table.c or not table.c.id.primary_key:
                        continue
                    target_connection.execute(
                        text(
                            "SELECT setval(pg_get_serial_sequence(:table_name, 'id'), "
                            'COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM "' + table.name + '"'
                        ),
                        {"table_name": table.name},
                    )
        counts = {}
        with target.connect() as connection:
            for table in tables:
                if table.name in target_tables:
                    counts[table.name] = connection.scalar(select(func.count()).select_from(table))
        print(f"Copied {sum(counts.values())} rows from {source_path} into PostgreSQL.")
        for table, count in counts.items():
            if count:
                print(f"  {table}: {count}")
        return 0
    finally:
        source.dispose()
        target.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
