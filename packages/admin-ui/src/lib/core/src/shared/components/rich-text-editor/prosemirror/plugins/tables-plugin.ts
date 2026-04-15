import { MenuElement, MenuItem } from 'prosemirror-menu';
import { Node, Schema } from 'prosemirror-model';
import { EditorState, Plugin, TextSelection, Transaction } from 'prosemirror-state';
import {
    addColumnAfter,
    addColumnBefore,
    addRowAfter,
    addRowBefore,
    deleteColumn,
    deleteRow,
    deleteTable,
    isInTable,
    mergeCells,
    splitCell,
    tableNodes,
    tableNodeTypes,
    toggleHeaderCell,
    toggleHeaderColumn,
    toggleHeaderRow,
} from 'prosemirror-tables';
import { Decoration, DecorationSet } from 'prosemirror-view';

import { ContextMenuItem, ContextMenuService } from '../context-menu/context-menu.service';
import { buildMenuItems } from '../menu/menu';
import { renderClarityIcon } from '../menu/menu-common';

export const tableContextMenuPlugin = (contextMenuService: ContextMenuService) =>
    new Plugin({
        view: () => ({
            update: view => {
                if (!view.hasFocus()) {
                    return;
                }
                const { doc, selection } = view.state;
                let tableNode: Node | undefined;
                let tableNodePos = 0;
                doc.nodesBetween(selection.from, selection.to, (n, pos, parent) => {
                    if (n.type.name === 'table') {
                        tableNode = n;
                        tableNodePos = pos;
                        return false;
                    }
                });
                if (tableNode) {
                    const node = view.nodeDOM(tableNodePos);
                    if (node instanceof Element) {
                        function createMenuItem(
                            label: string,
                            commandFn: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean,
                            iconClass?: string,
                        ): ContextMenuItem {
                            const enabled = commandFn(view.state);
                            return {
                                label,
                                enabled,
                                iconClass,
                                onClick: () => {
                                    contextMenuService.clearContextMenu();
                                    view.focus();
                                    commandFn(view.state, view.dispatch);
                                },
                            };
                        }
                        const separator: ContextMenuItem = {
                            label: '',
                            separator: true,
                            enabled: true,
                            onClick: () => {
                                /**/
                            },
                        };
                        contextMenuService.setContextMenu({
                            ref: selection,
                            title: 'Table',
                            iconShape: 'table',
                            element: node,
                            coords: view.coordsAtPos(tableNodePos),
                            items: [
                                createMenuItem('Insert column before', addColumnBefore as any, 'add-column'),
                                createMenuItem('Insert column after', addColumnAfter as any, 'add-column'),
                                createMenuItem('Insert row before', addRowBefore as any, 'add-row'),
                                createMenuItem('Insert row after', addRowAfter as any, 'add-row'),
                                createMenuItem('Merge cells', mergeCells as any),
                                createMenuItem('Split cell', splitCell as any),
                                separator,
                                createMenuItem('Toggle header column', toggleHeaderColumn as any),
                                createMenuItem('Toggle header row', toggleHeaderRow as any),
                                separator,
                                createMenuItem('Delete column', deleteColumn as any),
                                createMenuItem('Delete row', deleteRow as any),
                                createMenuItem('Delete table', deleteTable as any),
                            ],
                        });
                    }
                } else {
                    contextMenuService.clearContextMenu();
                }
            },
        }),
    });

export function getTableNodes() {
    return tableNodes({
        tableGroup: 'block',
        cellContent: 'block+',
        cellAttributes: {
            background: {
                default: null,
                getFromDOM(dom) {
                    return (dom as HTMLElement).style.backgroundColor || null;
                },
                setDOMAttr(value, attrs) {
                    if (value) {
                        attrs.style = (attrs.style || '') + `background-color: ${value};`;
                    }
                },
            },
        },
    });
}

export function getTableMenu(schema: Schema) {
    function item(
        label: string,
        cmd: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean,
        iconShape?: string,
    ) {
        return new MenuItem({
            label,
            select: cmd,
            run: cmd,
            render: iconShape ? renderClarityIcon({ shape: iconShape, label }) : undefined,
        });
    }

    function separator(): MenuElement {
        return new MenuItem({
            select: state => isInTable(state as any),
            run: state => {
                /**/
            },
            render: view => {
                const el = document.createElement('div');
                el.classList.add('menu-separator');
                return el;
            },
        });
    }

    return [
        item('Insert column before', addColumnBefore as any),
        item('Insert column after', addColumnAfter as any),
        item('Insert row before', addRowBefore as any),
        item('Insert row after', addRowAfter as any),
        item('Merge cells', mergeCells as any),
        item('Split cell', splitCell as any),
        separator(),
        item('Toggle header column', toggleHeaderColumn as any),
        item('Toggle header row', toggleHeaderRow as any),
        item('Toggle header cells', toggleHeaderCell as any),
        separator(),
        item('Delete column', deleteColumn as any),
        item('Delete row', deleteRow as any),
        item('Delete table', deleteTable as any),
    ];
}

export function addTable(state, dispatch, { rowsCount, colsCount, withHeaderRow, cellContent }) {
    const offset = state.tr.selection.anchor + 1;

    const nodes = createTable(state, rowsCount, colsCount, withHeaderRow, cellContent);
    const tr = state.tr.replaceSelectionWith(nodes as any).scrollIntoView();
    const resolvedPos = tr.doc.resolve(offset);

    tr.setSelection(TextSelection.near(resolvedPos));

    dispatch(tr);
}

function createTable(state, rowsCount, colsCount, withHeaderRow, cellContent) {
    const types = tableNodeTypes(state.schema as any);
    const headerCells: Node[] = [];
    const cells: Node[] = [];
    const createCell = (cellType, _cellContent) =>
        _cellContent ? cellType.createChecked(null, _cellContent as any) : cellType.createAndFill();

    for (let index = 0; index < colsCount; index += 1) {
        const cell = createCell(types.cell, cellContent);

        if (cell) {
            cells.push(cell as any);
        }

        if (withHeaderRow) {
            const headerCell = createCell(types.header_cell, cellContent);

            if (headerCell) {
                headerCells.push(headerCell as any);
            }
        }
    }

    const rows: Node[] = [];

    for (let index = 0; index < rowsCount; index += 1) {
        rows.push(types.row.createChecked(null, (withHeaderRow && index === 0 ? headerCells : cells) as any) as any);
    }

    return types.table.createChecked(null, rows as any);
}
