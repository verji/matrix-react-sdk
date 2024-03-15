/*
    Copyright 2024 Verji Tech AS. All rights reserved.
    Unauthorized copying or distribution of this file, via any medium, is strictly prohibited.
*/

import { MatrixEvent } from 'matrix-js-sdk';
import {
    findAllMatches,
    eventMatchesSearchTerms,
    makeSearchTermObject,
    isMemberMatch,
    SearchTerm
} from '../src/VerjiLocalSearch';

describe("LocalSearch", () => {
    it("should return true for matches", async () => {
        const testEvent: MatrixEvent = {
            getType: () => "m.room.message",
            isRedacted: () => false,
            getContent: () => ({ body: "bodytext" }),
            getSender: () => ({ userId: "testtestsson" }),
            getDate: () => new Date(),
        };

        const termObj: SearchTerm = {
            searchTypeAdvanced: false,
            searchTypeNormal: true,
            fullText: "bodytext",
            words: [{ word: "bodytext", highlight: false }],
            regExpHighlights: []
        };

        const isMatch = eventMatchesSearchTerms(termObj, testEvent, []);
        expect(isMatch).toBe(true);
    });

    it("finds only one match among several", async () => {
        const testEvent: MatrixEvent = {
            getType: () => "m.room.message",
            isRedacted: () => false,
            getContent: () => ({ body: "bodytext" }),
            getSender: () => ({ userId: "testtestsson" }),
            getDate: () => new Date(),
        };

        const testEvent2: MatrixEvent = {
            getType: () => "m.room.message",
            isRedacted: () => false,
            getContent: () => ({ body: "not that text at all" }),
            getSender: () => ({ userId: "testtestsson" }),
            getDate: () => new Date(),
        };

        const testEvent3: MatrixEvent = {
            getType: () => "m.room.message",
            isRedacted: () => false,
            getContent: () => ({ body: "some different text that doesn't match" }),
            getSender: () => ({ userId: "testtestsson" }),
            getDate: () => new Date(),
        };

        const room = {
            getLiveTimeline: () => {
                let timeline = {};
                timeline.getEvents = () => [testEvent, testEvent2, testEvent3];
                timeline.getNeighbouringTimeline = (direction) => null;
                return timeline;
            },
            currentState: {
                getMembers: () => [{ name: "Name Namesson", userId: "testtestsson" }]
            }
        };

        const termObj = {
            searchTypeAdvanced: false,
            searchTypeNormal: true,
            fullText: "bodytext",
            words: [{ word: "bodytext", highlight: false }],
            regExpHighlights: []
        };

        const matches = await findAllMatches(termObj, room, []);
        expect(matches.length).toBe(1);
    });

    it("finds several different with advanced search", async () => {
        const testEvent: MatrixEvent = {
            getType: () => "m.room.message",
            isRedacted: () => false,
            getContent: () => ({ body: "body text" }),
            getSender: () => ({ userId: "testtestsson" }),
            getDate: () => new Date(),
        };

        const testEvent2: MatrixEvent = {
            getType: () => "m.room.message",
            isRedacted: () => false,
            getContent: () => ({ body: "not that text at all" }),
            getSender: () => ({ userId: "testtestsson" }),
            getDate: () => new Date(),
        };

        const testEvent3: MatrixEvent = {
            getType: () => "m.room.message",
            isRedacted: () => false,
            getContent: () => ({ body: "some different text that doesn't match" }),
            getSender: () => ({ userId: "testtestsson" }),
            getDate: () => new Date(),
        };

        const testEvent4: MatrixEvent = {
            getType: () => "m.room.message",
            isRedacted: () => false,
            getContent: () => ({ body: "a text that isn't found" }),
            getSender: () => ({ userId: "testtestsson" }),
            getDate: () => new Date(),
        };

        const room = {
            getLiveTimeline: () => {
                let timeline = {};
                timeline.getEvents = () => [testEvent, testEvent2, testEvent3, testEvent4];
                timeline.getNeighbouringTimeline = (direction) => null;
                return timeline;
            }
        };

        const termObj = makeSearchTermObject("rx:(body|all|some)");
        expect(termObj.searchTypeAdvanced).toBe(true);

        const matches = await findAllMatches(termObj, room, []);
        expect(matches.length).toBe(3);
    });

    it("should be able to find messages sent by specific members", async () => {
        const testEvent: MatrixEvent = {
            getType: () => "m.room.message",
            isRedacted: () => false,
            getContent: () => ({ body: "body text Testsson" }),
            getSender: () => ({ userId: "testtestsson" }),
            getDate: () => new Date(),
        };

        const testEvent2: MatrixEvent = {
            getType: () => "m.room.message",
            isRedacted: () => false,
            getContent: () => ({ body: "not that text at all" }),
            getSender: () => ({ userId: "namersson" }),
            getDate: () => new Date(),
        };

        const testEvent3: MatrixEvent = {
            getType: () => "m.room.message",
            isRedacted: () => false,
            getContent: () => ({ body: "some different text, but not the one Testsson" }),
            getSender: () => ({ userId: "namersson" }),
            getDate: () => new Date(),
        };

        const testEvent4: MatrixEvent = {
            getType: () => "m.room.message",
            isRedacted: () => false,
            getContent: () => ({ body: "a text" }),
            getSender: () => ({ userId: "testtestsson" }),
            getDate: () => new Date(),
        };

        const room = {
            getLiveTimeline: () => {
                let timeline = {};
                timeline.getEvents = () => [testEvent, testEvent2, testEvent3, testEvent4];
                timeline.getNeighbouringTimeline = (direction) => null;
                return timeline;
            }
        };

        const foundUsers = {
            ["testtestsson"]: { name: "Test Testsson", userId: "testtestsson" },
        };

        const termObj = makeSearchTermObject("Testsson");
        const matches = await findAllMatches(termObj, room, foundUsers);
        console.log(matches.length)

        expect(matches.length).toBe(2);
        expect(matches[0].result.getSender().userId).toBe("namersson");
        expect(matches[1].result.getSender().userId).toBe("testtestsson");
    });

    it("can find by ISO date", async () => {
        const testEvent: MatrixEvent = {
            getType: () => "m.room.message",
            isRedacted: () => false,
            getContent: () => ({ body: "body text" }),
            getSender: () => ({ userId: "testtestsson" }),
            getDate: () => new Date(2020, 10, 2, 13, 30, 0),
        };

        const testEvent2: MatrixEvent = {
            getType: () => "m.room.message",
            isRedacted: () => false,
            getContent: () => ({ body: "not that text at all" }),
            getSender: () => ({ userId: "namersson" }),
            getDate: () => new Date(2020, 9, 28, 14, 0, 0),
        };

        const room = {
            getLiveTimeline: () => {
                const timeline = {
                    getEvents: () => [testEvent, testEvent2],
                    getNeighbouringTimeline: (direction) => null
                };
                return timeline;
            }
        };

        const foundUsers = {};
        const termObj = makeSearchTermObject("2020-10-28");
        const matches = await findAllMatches(termObj, room, foundUsers);
        expect(matches.length).toBe(1);
        expect(matches[0].result.getSender().userId).toBe("namersson");
    });

    it("matches users", async () => {
        const termObj = makeSearchTermObject("Namesson");
        const isMatch = isMemberMatch({ name: "Name Namesson", userId: "namenamesson" }, termObj);
        expect(isMatch).toBe(true);
    });
})
