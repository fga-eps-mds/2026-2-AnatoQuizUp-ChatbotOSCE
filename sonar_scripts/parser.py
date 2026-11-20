import json
import os
import time
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv
from packaging import version

TODAY = datetime.now(timezone.utc)

load_dotenv()
OWNER = "fga-eps-mds"
REPO = os.getenv("REPO")
REPO_ISSUES = os.getenv("REPO_DOC")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
SONAR_TOKEN = os.getenv("SONAR_TOKEN")
RELEASE_MAJOR = os.getenv("RELEASE_MAJOR")
RELEASE_MINOR = os.getenv("RELEASE_MINOR")
RELEASE_FIX = os.getenv("RELEASE_FIX")
SONAR_BRANCH = os.getenv("SONAR_BRANCH", "")
EXPECTED_SHA = os.getenv("EXPECTED_SHA", "")
SONAR_WAIT_SECONDS = int(os.getenv("SONAR_WAIT_SECONDS", "900"))

METRICS_SONAR = [
    "files",
    "functions",
    "complexity",
    "comment_lines_density",
    "duplicated_lines_density",
    "coverage",
    "ncloc",
    "tests",
    "test_errors",
    "test_failures",
    "test_execution_time",
    "security_rating",
]

api_url_runs = f"https://api.github.com/repos/{OWNER}/{REPO}/actions/runs"
api_url_issues = f"https://api.github.com/repos/{OWNER}/{REPO_ISSUES}/issues"


def get_latest_release():
    response = requests.get(
        f"https://api.github.com/repos/{OWNER}/{REPO}/releases",
        headers={"Authorization": f"token {GITHUB_TOKEN}"},
        timeout=60,
    )
    response.raise_for_status()
    releases = response.json()
    return releases[0].get("tag_name", "0.0.0") if releases else "0.0.0"


def new_tag_name():
    try:
        old_version = version.parse(get_latest_release().lstrip("v"))
    except version.InvalidVersion:
        old_version = version.parse("0.0.0")

    if RELEASE_MAJOR == "true":
        return f"v{old_version.major + 1}.0.0"
    if RELEASE_MINOR == "true":
        return f"v{old_version.major}.{old_version.minor + 1}.0"
    if RELEASE_FIX == "true":
        return f"v{old_version.major}.{old_version.minor}.{old_version.micro + 1}"
    return f"v{old_version}"


def create_release(tag):
    response = requests.post(
        f"https://api.github.com/repos/{OWNER}/{REPO}/releases",
        headers={
            "Authorization": f"token {GITHUB_TOKEN}",
            "Accept": "application/vnd.github.v3+json",
        },
        json={
            "tag_name": tag,
            "name": tag,
            "target_commitish": EXPECTED_SHA,
            "body": f"Commit analisado: {EXPECTED_SHA}\nBranch: {SONAR_BRANCH}",
        },
        timeout=60,
    )
    response.raise_for_status()
    return response.json().get("upload_url"), tag


def release_for_commit():
    response = requests.get(
        f"https://api.github.com/repos/{OWNER}/{REPO}/releases",
        headers={"Authorization": f"Bearer {GITHUB_TOKEN}"},
        params={"per_page": 100},
        timeout=60,
    )
    response.raise_for_status()
    return next(
        (
            release
            for release in response.json()
            if release.get("target_commitish") == EXPECTED_SHA
            and not release.get("draft")
        ),
        None,
    )


def sonar_get(endpoint, **params):
    response = requests.get(
        f"https://sonarcloud.io/api/{endpoint}",
        auth=(SONAR_TOKEN, ""),
        params={"branch": SONAR_BRANCH, **params},
        timeout=60,
    )
    response.raise_for_status()
    return response.json()


def latest_analysis(project_key):
    analyses = sonar_get(
        "project_analyses/search", project=project_key, ps=1
    ).get("analyses", [])
    return analyses[0] if analyses else {}


def wait_for_analysis(project_key):
    if not SONAR_TOKEN or not SONAR_BRANCH or not EXPECTED_SHA:
        raise RuntimeError(
            "Configure SONAR_TOKEN, SONAR_BRANCH e EXPECTED_SHA antes da coleta."
        )
    deadline = time.monotonic() + SONAR_WAIT_SECONDS
    while True:
        analysis = latest_analysis(project_key)
        if analysis.get("revision") == EXPECTED_SHA:
            status = sonar_get(
                "qualitygates/project_status", analysisId=analysis["key"]
            )
            if status["projectStatus"]["status"] != "OK":
                raise RuntimeError("Quality Gate reprovado para o commit solicitado.")
            return analysis
        if time.monotonic() >= deadline:
            raise RuntimeError(
                "O Sonar não publicou a análise do commit solicitado no prazo. "
                "Nenhuma métrica será atribuída a outra versão."
            )
        print(f"Aguardando análise de {SONAR_BRANCH} em {EXPECTED_SHA}...", flush=True)
        time.sleep(15)


def save_sonar_metrics(tag):
    if not SONAR_TOKEN:
        raise RuntimeError("SONAR_TOKEN não configurado.")

    project_key = f"fga-eps-mds_{REPO}"
    analysis = wait_for_analysis(project_key)
    metrics = ",".join(METRICS_SONAR)
    components = []
    page = 1
    base_component = None

    while True:
        response = requests.get(
            "https://sonarcloud.io/api/measures/component_tree",
            auth=(SONAR_TOKEN, ""),
            params={
                "component": project_key,
                "branch": SONAR_BRANCH,
                "metricKeys": metrics,
                "qualifiers": "FIL,DIR,UTS",
                "ps": 500,
                "p": page,
            },
            timeout=60,
        )
        response.raise_for_status()
        data = response.json()
        if base_component is None:
            base_component = data.get("baseComponent")
        components.extend(data.get("components", []))
        paging = data.get("paging", {})
        if page * paging.get("pageSize", 500) >= paging.get("total", 0):
            break
        page += 1

    measures = sonar_get(
        "measures/component", component=project_key, metricKeys=metrics
    )["component"]
    present = {
        item["metric"] for item in measures.get("measures", []) if "value" in item
    }
    missing = set(METRICS_SONAR) - present
    if missing:
        raise RuntimeError(
            "Métricas obrigatórias ausentes no Sonar: "
            f"{', '.join(sorted(missing))}. Confira a importação do XML dos testes na branch."
        )
    if latest_analysis(project_key).get("key") != analysis["key"]:
        raise RuntimeError(
            "A análise mudou durante a coleta. Execute novamente para evitar misturar versões."
        )
    if not components:
        raise RuntimeError("O Sonar retornou uma lista vazia de componentes.")

    formatted_tag = tag if tag.startswith("v") else f"v{tag}"
    os.makedirs("analytics-raw-data", exist_ok=True)
    file_path = (
        "./analytics-raw-data/"
        "fga-eps-mds-2026_2_UNB-AnatoQuizUp-ChatbotOSCE-"
        f"{TODAY.strftime('%m-%d-%Y-%H-%M-%S')}-{formatted_tag}.json"
    )
    result = {
        "timestamp": TODAY.isoformat(),
        "tag": formatted_tag,
        "project": project_key,
        "branch": SONAR_BRANCH,
        "commit": EXPECTED_SHA,
        "analysis": analysis,
        "project_measures": measures.get("measures", []),
        "metrics_requested": METRICS_SONAR,
        "baseComponent": base_component,
        "components": components,
    }
    with open(file_path, "w", encoding="utf-8") as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
    print(f"Métricas SonarCloud exportadas: {file_path}")
    print(f"Componentes coletados: {len(components)}")


def all_request_pages(data):
    total_runs = data["total_count"]
    pages = (total_runs // 100) + (1 if total_runs % 100 else 0)
    for page in range(2, pages + 1):
        response = requests.get(
            f"{api_url_runs}?page={page}",
            params={"per_page": 100},
            headers={"Authorization": f"Bearer {GITHUB_TOKEN}"},
            timeout=60,
        )
        response.raise_for_status()
        data["workflow_runs"].extend(response.json()["workflow_runs"])
    return data


def save_github_metrics_runs():
    response = requests.get(
        api_url_runs,
        params={"per_page": 100},
        headers={"Authorization": f"Bearer {GITHUB_TOKEN}"},
        timeout=60,
    )
    response.raise_for_status()
    data = all_request_pages(response.json())
    print(f"Quantidade de workflow_runs: {len(data['workflow_runs'])}")
    file_path = (
        "./analytics-raw-data/GitHub_API-Runs-fga-eps-mds-"
        f"{REPO}-{TODAY.strftime('%m-%d-%Y-%H-%M-%S')}.json"
    )
    with open(file_path, "w", encoding="utf-8") as output:
        json.dump(data, output)


def save_github_metrics_issues():
    issues = []
    page = 1
    while True:
        response = requests.get(
            api_url_issues,
            params={"state": "all", "per_page": 100, "page": page},
            headers={"Authorization": f"Bearer {GITHUB_TOKEN}"},
            timeout=60,
        )
        response.raise_for_status()
        page_issues = response.json()
        if not page_issues:
            break
        issues.extend(page_issues)
        page += 1
    print(f"Quantidade total de issues: {len(issues)}")
    file_path = (
        "./analytics-raw-data/GitHub_API-Issues-fga-eps-mds-"
        f"{REPO_ISSUES}-{TODAY.strftime('%m-%d-%Y-%H-%M-%S')}.json"
    )
    with open(file_path, "w", encoding="utf-8") as output:
        json.dump(issues, output, indent=4)


def main():
    if not GITHUB_TOKEN or not SONAR_TOKEN or not EXPECTED_SHA or not SONAR_BRANCH:
        raise RuntimeError(
            "Configure os tokens, EXPECTED_SHA e SONAR_BRANCH antes da coleta."
        )
    release_flags = [RELEASE_MAJOR, RELEASE_MINOR, RELEASE_FIX]
    if release_flags.count("true") > 1:
        raise RuntimeError("Use apenas uma label de release por PR.")

    is_release = any(flag == "true" for flag in release_flags)
    existing_release = None
    if is_release:
        if SONAR_BRANCH != "main":
            raise RuntimeError("Releases de produto devem partir da branch main.")
        existing_release = release_for_commit()
        tag = existing_release["tag_name"] if existing_release else new_tag_name()
    else:
        tag = get_latest_release()

    save_sonar_metrics(tag)
    save_github_metrics_runs()
    save_github_metrics_issues()
    if is_release and not existing_release:
        create_release(tag)


if __name__ == "__main__":
    main()
