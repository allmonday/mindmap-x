import httpx

from src.main import app
from src.models import Node


async def _post(path: str, payload: dict) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://test",
    ) as client:
        return await client.post(path, json=payload)


async def test_fold_rest_endpoints_return_no_content(session_factory, seeded_map):
    base = "/api/mindmap_service"

    response = await _post(
        f"{base}/set_node_collapsed",
        {
            "map_id": 100,
            "node_id": 2,
            "collapsed": True,
            "actor": "human",
            "client_request_id": "single",
        },
    )
    assert response.status_code == 204
    assert response.content == b""

    response = await _post(
        f"{base}/expand_all",
        {
            "map_id": 100,
            "actor": "human",
            "client_request_id": "all",
        },
    )
    assert response.status_code == 204
    assert response.content == b""

    response = await _post(
        f"{base}/set_fold_level",
        {
            "map_id": 100,
            "level": 2,
            "actor": "human",
            "client_request_id": "level",
        },
    )
    assert response.status_code == 204
    assert response.content == b""

    async with session_factory() as session:
        node = await session.get(Node, 201)
        assert node is not None
        assert node.collapsed is True
