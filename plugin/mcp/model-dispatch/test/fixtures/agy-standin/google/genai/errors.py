"""Stand-in for google.genai.errors: the APIError the typist worker reads a status from (its `.code`)."""


class APIError(Exception):
    def __init__(self, code, response_json, response=None):
        self.code = code
        self.details = response_json
        super().__init__(f"{code} {response_json}")


class ClientError(APIError):
    pass


class ServerError(APIError):
    pass
